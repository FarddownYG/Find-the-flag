import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { formatSize, latin1Decode, printableRatio, toHex, utf8Decode } from '../../lib/bytes';
import { printable } from './_pcap-addr';
import { tlsSni } from './_pcap-apps';
import { conversations, protocolHistogram, type Analysis, type DnsEvent } from './_pcap-analyze';
import { LINK_NAMES, tcpFlagNames, type Decoded } from './_pcap-decode';
import { dnsInfo, dnsRcodeName, dnsTypeName } from './_pcap-dns';
import { headerOf, looksLikeHttpRequest, looksLikeHttpResponse } from './_pcap-http';
import { dnsExfil, exportObjects, findFlagHits, icmpExfil } from './_pcap-extract';
import type { Stream } from './_pcap-streams';

const T = toolT('pcap');

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

function fmtTime(t: number): string {
  const d = new Date(t * 1000);
  if (!t || Number.isNaN(d.getTime())) return T('value.na');
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
        : T('value.emptyAnswer');
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
        answers.get(key) ?? T('value.noResponse'),
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
      text: T('note.truncated', { count: cap.truncated }),
    });
  }
  if (a.malformed) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.malformed', { count: a.malformed }),
    });
  }
  if (a.unsupported) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.unsupported', { count: a.unsupported }),
    });
  }
  if (!pkts.length) {
    out.push({ type: 'note', level: 'warn', text: T('note.noPackets') });
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
    label: T('label.capture'),
    entries: [
      [T('kv.format'), cap.format],
      [T('kv.packets'), String(pkts.length)],
      [T('kv.wire'), T('value.wire', { size: formatSize(wire), count: wire })],
      [
        T('kv.linkType'),
        cap.linkTypes.map((l) => LINK_NAMES[l] ?? T('value.linkType', { type: l })).join(', ') ||
          T('value.unknown'),
      ],
      [T('kv.start'), fmtTime(a.firstTime)],
      [
        T('kv.duration'),
        a.lastTime > a.firstTime
          ? T('value.seconds', { seconds: duration.toFixed(3) })
          : T('value.na'),
      ],
      [T('kv.hosts'), String(hosts.size)],
      [T('kv.tcpStreams'), String(tcp)],
      [T('kv.udpFlows'), String(udp)],
    ],
  });

  // The same flag usually shows up in the raw stream and in the decoded HTTP body: one row each.
  const byFlag = new Map<string, string[]>();
  for (const f of findFlagHits(a)) byFlag.set(f.flag, [...(byFlag.get(f.flag) ?? []), f.where]);
  if (byFlag.size) {
    out.push({
      type: 'note',
      level: 'success',
      text: T('note.flags', { count: byFlag.size }),
    });
    out.push({
      type: 'table',
      label: T('label.flags'),
      columns: [T('col.flag'), T('col.foundIn')],
      rows: [...byFlag].map(([flag, where]) => [
        flag,
        where.length > 3
          ? T('value.foundInMore', { list: where.slice(0, 3).join('; '), n: where.length - 3 })
          : where.join('; '),
      ]),
      highlight: [...byFlag.keys()].map((_, i) => i),
    });
  } else {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.noFlags'),
    });
  }

  const creds = a.credentials();
  if (creds.length) {
    out.push({
      type: 'table',
      label: T('label.credentials'),
      columns: [
        T('col.protocol'),
        T('col.server'),
        T('col.username'),
        T('col.secret'),
        T('col.stream'),
      ],
      rows: creds
        .slice(0, MAX_TABLE_ROWS)
        .map((c) => [c.proto, c.server, c.user, c.secret, c.stream]),
    });
  }

  const hist = protocolHistogram(pkts);
  out.push({
    type: 'table',
    label: T('label.protocols'),
    columns: [T('col.protocol'), T('col.packets'), T('col.bytes'), T('col.share')],
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
      label:
        convs.length > 20
          ? T('label.conversationsOf', { shown: 20, total: convs.length })
          : T('label.conversations'),
      columns: [
        T('col.endpointA'),
        T('col.endpointB'),
        T('col.protocol'),
        T('col.packets'),
        T('col.bytes'),
      ],
      rows: convs.slice(0, 20).map((c) => [c.a, c.b, c.proto, c.packets, c.bytes]),
    });
  }

  const dns = dnsRows(a.dns());
  if (dns.length) {
    out.push({
      type: 'table',
      label:
        dns.length > MAX_TABLE_ROWS
          ? T('label.dnsFirst', { shown: MAX_TABLE_ROWS, total: dns.length })
          : T('label.dns'),
      columns: [T('col.packet'), T('col.name'), T('col.type'), T('col.client'), T('col.answer')],
      rows: dns.slice(0, MAX_TABLE_ROWS),
    });
  }

  const http = a.http();
  if (http.length) {
    out.push({
      type: 'table',
      label:
        http.length > MAX_TABLE_ROWS
          ? T('label.httpFirst', { shown: MAX_TABLE_ROWS, total: http.length })
          : T('label.http'),
      columns: [
        T('col.stream'),
        T('col.method'),
        T('col.host'),
        T('col.uri'),
        T('col.status'),
        T('col.contentType'),
        T('col.bodyBytes'),
      ],
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
      label: T('label.sni'),
      columns: [T('col.stream'), T('col.client'), T('col.server'), T('col.serverName')],
      rows: sni.slice(0, MAX_TABLE_ROWS).map((x) => [x.stream, x.client, x.server, x.name]),
    });
  }

  const objects = a.http().filter((x) => x.response?.body.length).length + a.ftp.length;
  if (objects || a.streams.length) {
    out.push({
      type: 'note',
      level: 'info',
      text: objects
        ? T('note.nextWithFiles', {
            conversations: T('value.conversations', { count: a.streams.length }),
            files: T('value.files', { count: objects }),
          })
        : T('note.next', { conversations: T('value.conversations', { count: a.streams.length }) }),
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
  const p = {
    index: s.index,
    proto: s.proto,
    client: `${s.clientIp}:${s.clientPort}`,
    server: `${s.serverIp}:${s.serverPort}`,
  };
  return s.transport === 'UDP' ? T('label.udpFlow', p) : T('label.stream', p);
}

function transcript(s: Stream, view: View): string {
  const parts: string[] = [];
  let used = 0;
  let total = 0;
  for (const b of s.blocks) total += b.data.length;
  for (const b of s.blocks) {
    if (b.gapBefore > 0) parts.push(T('text.gap', { count: b.gapBefore }));
    const who = b.dir === 0 ? T('text.c2s') : T('text.s2c');
    // hexdump needs ~4 characters per byte, text one
    const room = Math.floor((MAX_STREAM_CHARS - used) / (view === 'hex' ? 4 : 1));
    if (room <= 0) {
      parts.push(T('text.outputCut', { size: formatSize(total) }));
      break;
    }
    const cut = b.data.length > room;
    const slice = cut ? b.data.subarray(0, room) : b.data;
    const body = view === 'hex' ? hexdump(slice) : toText(slice, view);
    used += body.length;
    parts.push(
      `${T('text.block', { who, count: b.data.length })}\n${body}${cut ? `\n${T('text.cut')}` : ''}`,
    );
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
        text: T('note.noStreams'),
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
        T('error.noSuchStream', { stream: o.stream, last: a.streams.length - 1 }),
      );
    }
    list = [one];
  }
  if (!list.length) {
    return [{ type: 'note', level: 'warn', text: T('note.noStreamMatch', { filter: o.filter }) }];
  }
  out.push({
    type: 'table',
    label:
      list.length === a.streams.length
        ? T('label.streams', { shown: list.length })
        : T('label.streamsOf', { shown: list.length, total: a.streams.length }),
    columns: [
      T('col.index'),
      T('col.protocol'),
      T('col.client'),
      T('col.server'),
      T('col.packets'),
      T('col.bytes'),
      T('col.notes'),
    ],
    rows: list.slice(0, 1000).map((s) => {
      const notes = [
        s.retransmits ? T('value.retransmitted', { count: s.retransmits }) : '',
        s.outOfOrder ? T('value.outOfOrder', { count: s.outOfOrder }) : '',
        s.missingBytes ? T('value.missingBytes', { count: s.missingBytes }) : '',
        s.rst ? T('value.reset') : '',
        s.transport === 'TCP' && !s.syn ? T('value.noHandshake') : '',
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
        text: T('note.budget'),
      });
      break;
    }
    const text = transcript(s, o.view);
    budget -= text.length;
    out.push({ type: 'text', label: streamLabel(s), value: text || T('text.noData') });
  }
  const left = list.filter((s) => s.bytes > 0).length - shown.length;
  if (o.stream < 0 && left > 0) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.moreStreams', { count: left }),
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
      text: T('note.firstPackets', { shown: MAX_PACKET_ROWS, count: matched }),
    });
  }
  if (!rows.length) {
    out.push({
      type: 'note',
      level: 'warn',
      text: ts.length ? T('note.noPacketMatch', { filter: o.filter }) : T('note.noPackets'),
    });
    return out;
  }
  out.push({
    type: 'table',
    label: T('label.packets', { total: matched }),
    columns: [
      T('col.no'),
      T('col.time'),
      T('col.source'),
      T('col.destination'),
      T('col.protocol'),
      T('col.length'),
      T('col.info'),
    ],
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
        text: ts.length ? T('note.noObjectMatch', { filter: o.filter }) : T('note.nothingToExport'),
      },
    ];
  }
  return [
    {
      type: 'note',
      level: 'success',
      text: T('note.exported', { count: files.length }),
    },
    { type: 'files', label: T('label.objects'), files },
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
        text: T('note.noExfil'),
      },
    ];
  }
  const block = (label: string, data: Uint8Array, filename: string): Output =>
    printableRatio(data) >= 0.85
      ? { type: 'text', label, value: toText(data, 'utf8') }
      : { type: 'bytes', label, value: data, filename };
  groups.forEach((g, i) => {
    const label = T('label.exfil', {
      group: g.label,
      packets: T('value.packets', { count: g.packets }),
      bytes: T('value.bytes', { count: g.data.length }),
    });
    out.push(block(label, g.data, `exfil-${i + 1}.bin`));
    if (g.note) {
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.group', { group: g.label, note: g.note }),
      });
    }
    for (const d of g.decodings) {
      out.push(
        block(
          T('label.exfilDecoded', { group: g.label, decoding: d.name }),
          d.data,
          `exfil-${i + 1}-decoded.bin`,
        ),
      );
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
