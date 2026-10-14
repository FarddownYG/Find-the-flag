import { buildFlagRegex, findFlags } from '../../core/flags';
import { fromBase64, fromHex, latin1Decode, latin1Encode, printableRatio } from '../../lib/bytes';
import { joinBytes } from './_pcap-addr';
import type { Analysis } from './_pcap-analyze';
import { headerOf, parseMultipart } from './_pcap-http';
import type { Stream } from './_pcap-streams';

// ---------- flag hunting ----------

export interface FlagHit {
  flag: string;
  where: string;
}

const MAX_FLAGS = 100;

function urlDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Flag-like strings in reassembled streams, HTTP bodies, UDP/ICMP payloads and DNS names. */
export function findFlagHits(a: Analysis, custom?: string): FlagHit[] {
  const re = buildFlagRegex(custom);
  const hits: FlagHit[] = [];
  const seen = new Set<string>();
  const scan = (text: string, where: string) => {
    if (hits.length >= MAX_FLAGS || !text.includes('{')) return;
    for (const f of findFlags(text, re, MAX_FLAGS)) {
      const key = `${f.value}\0${where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ flag: f.value, where });
    }
  };
  const label = (s: Stream) =>
    `${s.transport} stream ${s.index} (${s.clientIp}:${s.clientPort} to ${s.serverIp}:${s.serverPort})`;
  for (const s of a.streams) {
    scan(latin1Decode(s.c2s), `${label(s)}, client to server`);
    scan(latin1Decode(s.s2c), `${label(s)}, server to client`);
  }
  for (const x of a.http()) {
    for (const m of [x.request, x.response]) {
      if (!m) continue;
      const who = `HTTP ${m.kind === 'request' ? `${m.method} ${m.uri}` : m.startLine}, stream ${x.stream}`;
      scan(latin1Decode(m.body), `${who} (body)`);
      if (m.kind === 'request') scan(urlDecode(m.uri), `${who} (URL)`);
    }
  }
  for (const p of a.pkts) {
    if (p.transport === 'icmp' && p.icmp?.isEcho && p.payload.length) {
      scan(latin1Decode(p.payload), `ICMP packet ${p.no}`);
    } else if (p.transport === 'udp' && p.stream < 0 && p.payload.length) {
      scan(latin1Decode(p.payload), `${p.proto} packet ${p.no}`);
    }
  }
  for (const e of a.dns()) {
    for (const q of e.msg.questions) scan(q.name, `DNS name in packet ${e.no}`);
    for (const r of e.msg.answers) scan(r.data, `DNS answer in packet ${e.no}`);
  }
  for (const g of [...icmpExfil(a, false), ...dnsExfil(a, 2)]) {
    scan(latin1Decode(g.data), `${g.label} (joined)`);
    for (const d of g.decodings) scan(latin1Decode(d.data), `${g.label} (${d.name})`);
  }
  return hits.slice(0, MAX_FLAGS);
}

// ---------- ICMP / DNS exfiltration ----------

export interface ExfilGroup {
  kind: 'ICMP' | 'DNS';
  label: string;
  packets: number;
  /** All chunks glued together in order. */
  data: Uint8Array;
  /** Readable decodings of `data` (hex, base32, base64) when they give text or a known file. */
  decodings: { name: string; data: Uint8Array }[];
  /** Hint such as "looks like ordinary ping padding". */
  note: string;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function fromBase32(s: string): Uint8Array | null {
  const clean = s.replace(/=+$/, '').toUpperCase();
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const MAGICS: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png'],
  [[0xff, 0xd8, 0xff], 'jpg'],
  [[0x47, 0x49, 0x46, 0x38], 'gif'],
  [[0x50, 0x4b, 0x03, 0x04], 'zip'],
  [[0x25, 0x50, 0x44, 0x46], 'pdf'],
  [[0x1f, 0x8b, 0x08], 'gz'],
  [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], '7z'],
  [[0x52, 0x61, 0x72, 0x21], 'rar'],
  [[0x7f, 0x45, 0x4c, 0x46], 'elf'],
  [[0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66], 'sqlite'],
];

/** Extension of a well-known file format the bytes start with, or null. */
export function magicExtension(b: Uint8Array): string | null {
  for (const [magic, ext] of MAGICS) {
    if (b.length >= magic.length && magic.every((m, i) => b[i] === m)) return ext;
  }
  return null;
}

function decodingCandidates(data: Uint8Array): { name: string; data: Uint8Array }[] {
  const text = latin1Decode(data).replace(/\s+/g, '');
  if (text.length < 8) return [];
  const out: { name: string; data: Uint8Array }[] = [];
  const keep = (name: string, b: Uint8Array | null) => {
    if (b && b.length >= 4 && (printableRatio(b) >= 0.9 || magicExtension(b) !== null)) {
      out.push({ name, data: b });
    }
  };
  try {
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) keep('decoded from hex', fromHex(text));
    if (/^[A-Za-z2-7]+=*$/.test(text)) keep('decoded from base32', fromBase32(text));
    if (/^[A-Za-z0-9+/_-]+=*$/.test(text)) keep('decoded from base64', fromBase64(text));
  } catch {
    return out; // fromHex/fromBase64 reject malformed input: keep what decoded so far
  }
  return out;
}

/** Standard ping padding is an incrementing byte pattern: not interesting. */
function isPingPadding(p: Uint8Array): boolean {
  if (p.length < 16) return false;
  const tail = p.subarray(Math.min(16, p.length >> 1));
  let steps = 0;
  for (let i = 1; i < tail.length; i++) {
    const d = (tail[i]! - tail[i - 1]!) & 0xff;
    if (d === 1 || (tail[i - 1] === 0x77 && tail[i] === 0x61)) steps++;
  }
  return steps >= (tail.length - 1) * 0.9;
}

/** Echo-request payloads concatenated per source/destination pair, in capture order. */
export function icmpExfil(a: Analysis, sortBySeq: boolean): ExfilGroup[] {
  const groups = new Map<string, { seq: number; data: Uint8Array }[]>();
  for (const p of a.pkts) {
    if (p.transport !== 'icmp' || !p.icmp?.isEcho || !p.icmp.isRequest || !p.payload.length)
      continue;
    const key = `${p.src} to ${p.dst}`;
    const list = groups.get(key) ?? [];
    list.push({ seq: p.icmp.seq, data: p.payload });
    groups.set(key, list);
  }
  const out: ExfilGroup[] = [];
  for (const [key, list] of groups) {
    if (sortBySeq) list.sort((x, y) => x.seq - y.seq);
    const data = joinBytes(list.map((x) => x.data));
    const padding = list.every((x) => isPingPadding(x.data));
    out.push({
      kind: 'ICMP',
      label: `ICMP echo requests ${key}`,
      packets: list.length,
      data,
      decodings: decodingCandidates(data),
      note: padding
        ? 'Looks like ordinary ping padding (incrementing bytes), probably not exfiltration.'
        : '',
    });
  }
  return out.sort(
    (x, y) => Number(x.note !== '') - Number(y.note !== '') || y.data.length - x.data.length,
  );
}

/** Subdomain labels of queries to the same domain, glued in order ("<data>.evil.example"). */
export function dnsExfil(a: Analysis, domainLabels: number): ExfilGroup[] {
  const keep = Math.max(1, Math.round(domainLabels));
  const groups = new Map<string, { names: string[]; chunks: string[] }>();
  for (const e of a.dns()) {
    if (e.msg.response) continue;
    const name = e.msg.questions[0]?.name;
    if (!name) continue;
    const labels = name.split('.').filter(Boolean);
    if (labels.length <= keep) continue;
    const domain = labels.slice(-keep).join('.').toLowerCase();
    const g = groups.get(domain) ?? { names: [], chunks: [] };
    // resolvers retry and ask A then AAAA: the same name twice in a row is one chunk
    if (g.names[g.names.length - 1] !== name) {
      g.names.push(name);
      g.chunks.push(labels.slice(0, -keep).join(''));
    }
    groups.set(domain, g);
  }
  const out: ExfilGroup[] = [];
  for (const [domain, g] of groups) {
    if (g.names.length < 2) continue;
    const data = latin1Encode(g.chunks.join(''));
    out.push({
      kind: 'DNS',
      label: `DNS subdomain labels under ${domain}`,
      packets: g.names.length,
      data,
      decodings: decodingCandidates(data),
      note: '',
    });
  }
  return out.sort((x, y) => y.packets - x.packets).slice(0, 8);
}

// ---------- export objects ----------

export interface ExportedFile {
  name: string;
  data: Uint8Array;
  note: string;
}

const EXT_BY_TYPE: Record<string, string> = {
  'text/html': 'html',
  'text/plain': 'txt',
  'text/css': 'css',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'application/json': 'json',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/octet-stream': 'bin',
};

function safeName(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
}

/** File name Wireshark-style: last path segment of the URL, or "index" + extension from the type. */
function nameFromUri(uri: string, contentType: string): string {
  const path = uri.split(/[?#]/)[0]!.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const last = path.split('/').filter(Boolean).pop() ?? '';
  let base = safeName(urlDecode(last));
  if (!base) base = 'index';
  if (!base.includes('.')) {
    const ext = EXT_BY_TYPE[contentType.split(';')[0]!.trim().toLowerCase()];
    if (ext) base += `.${ext}`;
    else if (base === 'index') base += '.html';
  }
  return base;
}

/** HTTP bodies, multipart uploads, FTP-DATA transfers and raw streams that carry a known file. */
export function exportObjects(a: Analysis): ExportedFile[] {
  const out: ExportedFile[] = [];
  const used = new Map<string, number>();
  const add = (name: string, data: Uint8Array, note: string) => {
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    let final = name;
    if (n > 0) {
      const dot = name.lastIndexOf('.');
      final = dot > 0 ? `${name.slice(0, dot)}_${n + 1}${name.slice(dot)}` : `${name}_${n + 1}`;
    }
    out.push({ name: final, data, note });
  };
  for (const x of a.http()) {
    const req = x.request;
    const res = x.response;
    const where = `${x.host}${req?.uri ?? ''}`.slice(0, 120);
    if (res && res.body.length && res.status !== 304) {
      const type = headerOf(res, 'content-type') ?? '';
      const notes = res.notes.length ? `, ${res.notes.join(', ')}` : '';
      add(
        nameFromUri(req?.uri ?? '/', type),
        res.body,
        `HTTP ${res.status} ${type.split(';')[0]!.trim() || 'no content type'} from ${where}, stream ${x.stream}, ${res.body.length} bytes${notes}`,
      );
    }
    if (req && req.body.length && req.method !== 'GET') {
      const type = headerOf(req, 'content-type') ?? '';
      const parts = type.toLowerCase().includes('multipart/') ? parseMultipart(req.body, type) : [];
      const files = parts.filter((p) => p.filename);
      if (files.length) {
        for (const p of files) {
          add(
            safeName(p.filename!.split(/[\\/]/).pop() ?? '') || 'upload.bin',
            p.data,
            `${req.method} upload (field "${p.name}") to ${where}, stream ${x.stream}, ${p.data.length} bytes`,
          );
        }
      } else {
        add(
          `${req.method.toLowerCase()}-${nameFromUri(req.uri, type)}`,
          req.body,
          `${req.method} body to ${where}, stream ${x.stream}, ${req.body.length} bytes`,
        );
      }
    }
  }
  for (const t of a.ftp) {
    const bigger = t.data.s2c.length >= t.data.c2s.length ? t.data.s2c : t.data.c2s;
    if (!bigger.length) continue;
    const isList = t.name === 'listing';
    add(
      isList ? 'ftp-listing.txt' : safeName(t.name.split('/').pop() ?? '') || 'ftp-file.bin',
      bigger,
      `FTP-DATA ${t.upload ? 'upload' : isList ? 'listing' : 'download'} on stream ${t.data.index}, ${bigger.length} bytes`,
    );
  }
  for (const s of a.streams) {
    if (s.transport !== 'TCP' || s.proto !== 'TCP') continue;
    for (const [dir, data] of [
      ['client to server', s.c2s],
      ['server to client', s.s2c],
    ] as const) {
      const ext = magicExtension(data);
      if (ext)
        add(
          `stream-${s.index}.${ext}`,
          data,
          `raw TCP stream ${s.index} (${dir}), ${data.length} bytes`,
        );
    }
  }
  return out;
}
