import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { formatSize, latin1Decode, printableRatio, toHex, utf8Decode } from '../../lib/bytes';
import { printable } from './_pcap-addr';
import { tlsSni } from './_pcap-apps';
import { conversations, protocolHistogram, type Analysis, type DnsEvent } from './_pcap-analyze';
import { LINK_NAMES, tcpFlagNames, type Decoded } from './_pcap-decode';
import { dnsInfo, dnsRcodeName, dnsTypeName } from './_pcap-dns';
import { headerOf, looksLikeHttpRequest, looksLikeHttpResponse } from './_pcap-http';
import { dnsExfil, exportObjects, findFlagHits, icmpExfil } from './_pcap-extract';
import type { Stream } from './_pcap-streams';

export type Mode = 'overview' | 'streams' | 'export' | 'packets' | 'exfil';
export type View = 'ascii' | 'utf8' | 'hex';

export interface PcapOptions {
  mode: Mode;
  filter: string;
  stream: number;
  limit: number;
  view: View;
  domainLabels: number;
  sortSeq: boolean;
}

const MAX_PACKET_ROWS = 5000;
const MAX_TABLE_ROWS = 300;
/** Characters of transcript per stream / in total, to keep the page responsive. */
const MAX_STREAM_CHARS = 200_000;
const MAX_TOTAL_CHARS = 1_500_000;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function fmtTime(t: number): string {
  const d = new Date(t * 1000);
  if (!t || Number.isNaN(d.getTime())) return 'n/a';
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

const terms = (filter: string): string[] => filter.toLowerCase().split(/\s+/).filter(Boolean);
const matches = (ts: string[], hay: string): boolean => {
  const h = hay.toLowerCase();
  return ts.every((t) => h.includes(t));
};

// ---------- packet descriptions ----------

const TLS_HANDSHAKE: Record<number, string> = {
  1: 'Client Hello',
  2: 'Server Hello',
  4: 'New Session Ticket',
  11: 'Certificate',
  12: 'Server Key Exchange',
  14: 'Server Hello Done',
  16: 'Client Key Exchange',
  20: 'Finished',
};

const firstLine = (b: Uint8Array): string => {
  const text = latin1Decode(b.subarray(0, 200));
  const i = text.search(/\r|\n/);
  return printable(i < 0 ? text : text.slice(0, i)).slice(0, 100);
};

function appInfo(p: Decoded, s: Stream | undefined): string | null {
  const b = p.payload;
  if (!b.length) return null;
  const fromServer = s ? p.src === s.serverIp && p.sport === s.serverPort : false;
  switch (p.proto) {
    case 'HTTP':
      if (looksLikeHttpRequest(b) || looksLikeHttpResponse(b)) return firstLine(b);
      return 'Continuation';
    case 'FTP':
    case 'SMTP':
    case 'POP':
    case 'IMAP':
      return `${fromServer ? 'Response' : 'Request'}: ${firstLine(b)}`;
    case 'TLS': {
      const t = b[0]!;
      if (t === 0x16) {
        const name = b[5] === 1 ? tlsSni(b) : null;
        return name ? `Client Hello (SNI=${name})` : (TLS_HANDSHAKE[b[5]!] ?? 'Handshake');
      }
      return t === 0x17
        ? 'Application Data'
        : t === 0x14
          ? 'Change Cipher Spec'
          : t === 0x15
            ? 'Alert'
            : 'TLS data';
    }
    case 'SSH':
      return b[0] === 0x53 && b[1] === 0x53 ? firstLine(b) : 'Encrypted packet';
    case 'Telnet':
      return `Telnet data (${b.length} bytes)`;
    default:
      return null;
  }
}

/** The "Info" column, close to what Wireshark prints. */
export function packetInfo(p: Decoded, streams: Stream[]): string {
  if (p.dns) return dnsInfo(p.dns);
  if (p.info) return p.info;
  if (p.tcp) {
    const stream = streams[p.stream];
    const app = appInfo(p, stream);
    if (app) return stream?.retransmitted.has(p.no) ? `[TCP Retransmission] ${app}` : app;
    const t = p.tcp;
    const retrans = stream?.retransmitted.has(p.no) ? '[TCP Retransmission] ' : '';
    return `${retrans}${p.sport} -> ${p.dport} [${tcpFlagNames(t.flags)}] Seq=${t.seq} Ack=${t.ack} Win=${t.win} Len=${p.payload.length}`;
  }
  if (p.transport === 'udp') return `${p.sport} -> ${p.dport} Len=${p.payload.length}`;
  return '';
}

// ---------- overview ----------

function dnsRows(events: DnsEvent[]): (string | number)[][] {
  const answers = new Map<string, string>();
  for (const e of events) {
    if (!e.msg.response) continue;
    const q = e.msg.questions[0];
    if (!q) continue;
    const text = e.msg.answers.length
      ? e.msg.answers.map((r) => `${dnsTypeName(r.type)} ${r.data}`).join(', ')
      : e.msg.rcode
        ? dnsRcodeName(e.msg.rcode)
        : '(empty answer)';
    answers.set(`${e.msg.id}|${e.dst}|${q.name.toLowerCase()}|${q.type}`, text);
  }
  const rows: (string | number)[][] = [];
  const asked = new Set<string>();
  for (const e of events) {
    const q = e.msg.questions[0];
    if (!q) continue;
    if (!e.msg.response) {
      const key = `${e.msg.id}|${e.src}|${q.name.toLowerCase()}|${q.type}`;
      asked.add(key);
      rows.push([
        e.no,
        printable(q.name),
        dnsTypeName(q.type),
        e.src,
        answers.get(key) ?? '(no response seen)',
      ]);
    }
  }
  for (const e of events) {
    const q = e.msg.questions[0];
    if (!e.msg.response || !q) continue;
    const key = `${e.msg.id}|${e.dst}|${q.name.toLowerCase()}|${q.type}`;
    if (!asked.has(key)) {
      rows.push([e.no, printable(q.name), dnsTypeName(q.type), e.dst, answers.get(key) ?? '']);
    }
  }
  return rows.sort((x, y) => Number(x[0]) - Number(y[0]));
}

function overview(a: Analysis): Output[] {
  const out: Output[] = [];
  const { cap, pkts } = a;
  if (cap.truncated) {
    out.push({
      type: 'note',
      level: 'warn',
      text: `${plural(cap.truncated, 'record')} cut off at the end of the file (truncated download or capture?). Everything before it was analysed.`,
    });
  }
  if (a.malformed) {
    out.push({
      type: 'note',
      level: 'warn',
      text: `${plural(a.malformed, 'packet')} too short or damaged to decode (skipped in the tables below).`,
    });
  }
  if (a.unsupported) {
    out.push({
      type: 'note',
      level: 'warn',
      text: `${plural(a.unsupported, 'packet')} use a link type that is not supported (supported: Ethernet, Linux cooked, raw IP, loopback, 802.11).`,
    });
  }
  if (!pkts.length) {
    out.push({ type: 'note', level: 'warn', text: 'The capture contains no packets.' });
    return out;
  }

  const hosts = new Set<string>();
  let wire = 0;
  for (const p of pkts) {
    wire += p.len;
    if (p.transport) {
      hosts.add(p.src);
      hosts.add(p.dst);
    }
  }
  const tcp = a.streams.filter((s) => s.transport === 'TCP').length;
  const udp = a.streams.length - tcp;
  const duration = a.lastTime - a.firstTime;
  out.push({
    type: 'kv',
    label: 'Capture',
    entries: [
      ['Format', cap.format],
      ['Packets', String(pkts.length)],
      ['Data on the wire', `${formatSize(wire)} (${wire} bytes)`],
      ['Link type', cap.linkTypes.map((l) => LINK_NAMES[l] ?? `type ${l}`).join(', ') || 'unknown'],
      ['Start', fmtTime(a.firstTime)],
      ['Duration', a.lastTime > a.firstTime ? `${duration.toFixed(3)} s` : 'n/a'],
      ['Hosts', String(hosts.size)],
      ['TCP streams', String(tcp)],
      ['UDP flows', String(udp)],
    ],
  });

  // The same flag usually shows up in the raw stream and in the decoded HTTP body: one row each.
  const byFlag = new Map<string, string[]>();
  for (const f of findFlagHits(a)) byFlag.set(f.flag, [...(byFlag.get(f.flag) ?? []), f.where]);
  if (byFlag.size) {
    out.push({
      type: 'note',
      level: 'success',
      text: `Found ${plural(byFlag.size, 'flag-like string')} in the payloads.`,
    });
    out.push({
      type: 'table',
      label: 'Flag-like strings',
      columns: ['Flag', 'Found in'],
      rows: [...byFlag].map(([flag, where]) => [
        flag,
        where.slice(0, 3).join('; ') + (where.length > 3 ? ` (+${where.length - 3} more)` : ''),
      ]),
      highlight: [...byFlag.keys()].map((_, i) => i),
    });
  } else {
    out.push({
      type: 'note',
      level: 'info',
      text: 'No flag-like string (word{...}) in the payloads. Try Follow streams, Export objects or ICMP/DNS exfil; the data may be encoded.',
    });
  }

  const creds = a.credentials();
  if (creds.length) {
    out.push({
      type: 'table',
      label: 'Credentials sent in the clear',
      columns: ['Protocol', 'Server', 'Username', 'Password / secret', 'Stream'],
      rows: creds
        .slice(0, MAX_TABLE_ROWS)
        .map((c) => [c.proto, c.server, c.user, c.secret, c.stream]),
    });
  }

  const hist = protocolHistogram(pkts);
  out.push({
    type: 'table',
    label: 'Protocols',
    columns: ['Protocol', 'Packets', 'Bytes', 'Share'],
    rows: hist.map((h) => [
      h.proto,
      h.packets,
      h.bytes,
      `${((h.packets / pkts.length) * 100).toFixed(1)}%`,
    ]),
  });

  const convs = conversations(pkts);
  if (convs.length) {
    out.push({
      type: 'table',
      label: `Top conversations${convs.length > 20 ? ` (20 of ${convs.length})` : ''}`,
      columns: ['Endpoint A', 'Endpoint B', 'Protocol', 'Packets', 'Bytes'],
      rows: convs.slice(0, 20).map((c) => [c.a, c.b, c.proto, c.packets, c.bytes]),
    });
  }

  const dns = dnsRows(a.dns());
  if (dns.length) {
    out.push({
      type: 'table',
      label: `DNS queries${dns.length > MAX_TABLE_ROWS ? ` (first ${MAX_TABLE_ROWS} of ${dns.length})` : ''}`,
      columns: ['Packet', 'Name', 'Type', 'Client', 'Answer'],
      rows: dns.slice(0, MAX_TABLE_ROWS),
    });
  }

  const http = a.http();
  if (http.length) {
    out.push({
      type: 'table',
      label: `HTTP requests${http.length > MAX_TABLE_ROWS ? ` (first ${MAX_TABLE_ROWS} of ${http.length})` : ''}`,
      columns: ['Stream', 'Method', 'Host', 'URI', 'Status', 'Content-Type', 'Body bytes'],
      rows: http
        .slice(0, MAX_TABLE_ROWS)
        .map((x) => [
          x.stream,
          x.request?.method ?? '',
          printable(x.host),
          printable(x.request?.uri ?? '').slice(0, 160),
          x.response?.status ?? '',
          x.response ? (headerOf(x.response, 'content-type') ?? '') : '',
          x.response?.body.length ?? 0,
        ]),
    });
  }

  const sni = a.sni();
  if (sni.length) {
    out.push({
      type: 'table',
      label: 'TLS server names (SNI)',
      columns: ['Stream', 'Client', 'Server', 'Server name'],
      rows: sni.slice(0, MAX_TABLE_ROWS).map((x) => [x.stream, x.client, x.server, x.name]),
    });
  }

  const objects = a.http().filter((x) => x.response?.body.length).length + a.ftp.length;
  if (objects || a.streams.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: `Next: "Follow streams" shows the ${plural(a.streams.length, 'conversation')} as text${objects ? `, "Export objects" saves the ${plural(objects, 'file')} found` : ''}.`,
    });
  }
  return out;
}

// ---------- follow streams ----------

/** Printable text for a transcript: control bytes become ".", CRLF becomes a newline. */
function toText(b: Uint8Array, view: View): string {
  const s = view === 'utf8' ? utf8Decode(b) : latin1Decode(b);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 10 || c === 9) out += s[i];
    else if (c === 13) out += s.charCodeAt(i + 1) === 10 ? '' : '.';
    else if (c < 32 || c === 127 || (view === 'ascii' && c > 126)) out += '.';
    else out += s[i];
  }
  return out;
}

function hexdump(b: Uint8Array): string {
  const lines: string[] = [];
  for (let o = 0; o < b.length; o += 16) {
    const row = b.subarray(o, o + 16);
    const hex = toHex(row, ' ').padEnd(47, ' ');
    let asc = '';
    for (const c of row) asc += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
    lines.push(`${o.toString(16).padStart(8, '0')}  ${hex}  ${asc}`);
  }
  return lines.join('\n');
}

function streamLabel(s: Stream): string {
  return `${s.transport === 'UDP' ? 'UDP flow' : 'Stream'} ${s.index} - ${s.proto} - ${s.clientIp}:${s.clientPort} -> ${s.serverIp}:${s.serverPort}`;
}

function transcript(s: Stream, view: View): string {
  const parts: string[] = [];
  let used = 0;
  let total = 0;
  for (const b of s.blocks) total += b.data.length;
  for (const b of s.blocks) {
    if (b.gapBefore > 0) parts.push(`[... ${b.gapBefore} bytes missing: not in the capture ...]`);
    const who = b.dir === 0 ? '>>> client -> server' : '<<< server -> client';
    // hexdump needs ~4 characters per byte, text one
    const room = Math.floor((MAX_STREAM_CHARS - used) / (view === 'hex' ? 4 : 1));
    if (room <= 0) {
      parts.push(
        `[... output cut: ${formatSize(total)} in this stream, showing the first part ...]`,
      );
      break;
    }
    const cut = b.data.length > room;
    const slice = cut ? b.data.subarray(0, room) : b.data;
    const body = view === 'hex' ? hexdump(slice) : toText(slice, view);
    used += body.length;
    parts.push(`${who}, ${plural(b.data.length, 'byte')}\n${body}${cut ? '\n[... cut ...]' : ''}`);
  }
  return parts.join('\n\n');
}

function streamsMode(a: Analysis, o: PcapOptions): Output[] {
  const out: Output[] = [];
  if (!a.streams.length) {
    return [
      {
        type: 'note',
        level: 'warn',
        text: 'No TCP stream or UDP flow with data in this capture. Use "Packets" to see what it contains.',
      },
    ];
  }
  const ts = terms(o.filter);
  const wanted = (s: Stream): boolean => {
    if (!ts.length) return true;
    const head = `${s.transport} ${s.proto} ${s.clientIp}:${s.clientPort} ${s.serverIp}:${s.serverPort} stream ${s.index}`;
    if (matches(ts, head)) return true;
    return matches(ts, `${head} ${latin1Decode(s.c2s)} ${latin1Decode(s.s2c)}`);
  };
  let list = a.streams.filter(wanted);
  if (o.stream >= 0) {
    const one = a.streams[o.stream];
    if (!one) {
      throw new ToolError(
        `Stream ${o.stream} does not exist: this capture has streams 0 to ${a.streams.length - 1}. Set "Stream" to -1 to list them.`,
      );
    }
    list = [one];
  }
  if (!list.length) {
    return [{ type: 'note', level: 'warn', text: `No stream matches the filter "${o.filter}".` }];
  }
  out.push({
    type: 'table',
    label: `Streams (${list.length}${list.length === a.streams.length ? '' : ` of ${a.streams.length}`})`,
    columns: ['#', 'Protocol', 'Client', 'Server', 'Packets', 'Bytes', 'Notes'],
    rows: list.slice(0, 1000).map((s) => {
      const notes = [
        s.retransmits ? `${s.retransmits} retransmitted` : '',
        s.outOfOrder ? `${s.outOfOrder} out of order` : '',
        s.missingBytes ? `${s.missingBytes} bytes missing` : '',
        s.rst ? 'reset' : '',
        s.transport === 'TCP' && !s.syn ? 'no handshake captured' : '',
      ].filter(Boolean);
      return [
        s.index,
        s.transport === 'UDP' ? 'UDP' : s.proto,
        `${s.clientIp}:${s.clientPort}`,
        `${s.serverIp}:${s.serverPort}`,
        s.packets,
        s.bytes,
        notes.join(', '),
      ];
    }),
  });
  const shown =
    o.stream >= 0 ? list : list.filter((s) => s.bytes > 0).slice(0, Math.max(1, o.limit));
  let budget = MAX_TOTAL_CHARS;
  for (const s of shown) {
    if (budget <= 0) {
      out.push({
        type: 'note',
        level: 'info',
        text: 'Output size limit reached. Pick a single stream with the "Stream" option to read the rest.',
      });
      break;
    }
    const text = transcript(s, o.view);
    budget -= text.length;
    out.push({ type: 'text', label: streamLabel(s), value: text || '(no data in this stream)' });
  }
  const left = list.filter((s) => s.bytes > 0).length - shown.length;
  if (o.stream < 0 && left > 0) {
    out.push({
      type: 'note',
      level: 'info',
      text: `${plural(left, 'more stream')} with data not shown: raise "Streams shown", or set "Stream" to a number from the table.`,
    });
  }
  return out;
}

// ---------- packets ----------

function packetsMode(a: Analysis, o: PcapOptions): Output[] {
  const ts = terms(o.filter);
  const t0 = a.firstTime;
  const rows: (string | number)[][] = [];
  let matched = 0;
  for (const p of a.pkts) {
    if (!ts.length && rows.length >= MAX_PACKET_ROWS) {
      matched = a.pkts.length; // nothing to filter: skip describing packets nobody will see
      break;
    }
    const info = packetInfo(p, a.streams);
    if (ts.length && !matches(ts, `${p.src} ${p.dst} ${p.sport} ${p.dport} ${p.proto} ${info}`))
      continue;
    matched++;
    if (rows.length < MAX_PACKET_ROWS) {
      rows.push([
        p.no,
        p.time > 0 ? (p.time - t0).toFixed(6) : '-',
        p.src,
        p.dst,
        p.proto,
        p.len,
        printable(info),
      ]);
    }
  }
  const out: Output[] = [];
  if (matched > rows.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: `Showing the first ${MAX_PACKET_ROWS} of ${matched} packets. Narrow it with the Filter option.`,
    });
  }
  if (!rows.length) {
    out.push({
      type: 'note',
      level: 'warn',
      text: ts.length ? `No packet matches "${o.filter}".` : 'The capture contains no packets.',
    });
    return out;
  }
  out.push({
    type: 'table',
    label: `Packets (${matched})`,
    columns: ['No.', 'Time', 'Source', 'Destination', 'Protocol', 'Length', 'Info'],
    rows,
  });
  return out;
}

// ---------- export ----------

function exportMode(a: Analysis, o: PcapOptions): Output[] {
  const ts = terms(o.filter);
  const files = exportObjects(a).filter((f) => !ts.length || matches(ts, `${f.name} ${f.note}`));
  if (!files.length) {
    return [
      {
        type: 'note',
        level: 'warn',
        text: ts.length
          ? `No exported object matches "${o.filter}".`
          : 'Nothing to export: no HTTP bodies, FTP-DATA transfers or raw TCP streams that start with a known file signature. Use "Follow streams" to read the conversations.',
      },
    ];
  }
  return [
    {
      type: 'note',
      level: 'success',
      text: `${plural(files.length, 'object')} extracted (HTTP bodies are decoded: chunked and gzip removed).`,
    },
    { type: 'files', label: 'Objects', files },
  ];
}

// ---------- exfiltration ----------

function exfilMode(a: Analysis, o: PcapOptions): Output[] {
  const out: Output[] = [];
  const groups = [...icmpExfil(a, o.sortSeq), ...dnsExfil(a, o.domainLabels)];
  if (!groups.length) {
    return [
      {
        type: 'note',
        level: 'warn',
        text: 'No ICMP echo request with a payload and no DNS query with subdomain labels found. If the data hides in DNS, set "Domain labels" to the number of labels in the attacker domain (2 for evil.example).',
      },
    ];
  }
  const block = (label: string, data: Uint8Array, filename: string): Output =>
    printableRatio(data) >= 0.85
      ? { type: 'text', label, value: toText(data, 'utf8') }
      : { type: 'bytes', label, value: data, filename };
  groups.forEach((g, i) => {
    const label = `${g.label}: ${plural(g.packets, 'packet')}, ${plural(g.data.length, 'byte')}`;
    out.push(block(label, g.data, `exfil-${i + 1}.bin`));
    if (g.note) out.push({ type: 'note', level: 'info', text: `${g.label}: ${g.note}` });
    for (const d of g.decodings) {
      out.push(block(`${g.label} - ${d.name}`, d.data, `exfil-${i + 1}-decoded.bin`));
    }
  });
  return out;
}

export function render(a: Analysis, o: PcapOptions): Output[] {
  switch (o.mode) {
    case 'streams':
      return streamsMode(a, o);
    case 'packets':
      return packetsMode(a, o);
    case 'export':
      return exportMode(a, o);
    case 'exfil':
      return exfilMode(a, o);
    default:
      return overview(a);
  }
}
