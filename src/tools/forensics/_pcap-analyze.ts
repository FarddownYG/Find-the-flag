import { u16be } from '../../lib/bytes';
import {
  classifyStream,
  cleartextCredentials,
  findFtpTransfers,
  httpCredentials,
  tlsSni,
  type Credential,
  type FtpTransfer,
} from './_pcap-apps';
import { FragmentTable, decodePacket, type Decoded } from './_pcap-decode';
import { parseDns, type DnsMessage } from './_pcap-dns';
import { headerOf, parseHttpStream, type HttpMessage } from './_pcap-http';
import { readCapture, type Capture } from './_pcap-read';
import { buildStreams, type Stream } from './_pcap-streams';

export interface HttpExchange {
  stream: number;
  time: number;
  host: string;
  server: string;
  request: HttpMessage | null;
  response: HttpMessage | null;
}

export interface DnsEvent {
  no: number;
  time: number;
  src: string;
  dst: string;
  msg: DnsMessage;
}

export interface Analysis {
  cap: Capture;
  pkts: Decoded[];
  streams: Stream[];
  firstTime: number;
  lastTime: number;
  /** Frames too short or damaged to decode. */
  malformed: number;
  /** Frames of a link type we cannot decode. */
  unsupported: number;
  http: () => HttpExchange[];
  dns: () => DnsEvent[];
  credentials: () => Credential[];
  ftp: FtpTransfer[];
  sni: () => { stream: number; client: string; server: string; name: string }[];
}

function lazy<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}

/** Decode a whole capture file: packets, reassembled streams and protocol classification. */
export function analyze(bytes: Uint8Array): Analysis {
  const cap = readCapture(bytes);
  const frags = new FragmentTable();
  const pkts: Decoded[] = new Array<Decoded>(cap.packets.length);
  let malformed = 0;
  let unsupported = 0;
  let first = Infinity;
  let last = -Infinity;
  for (let i = 0; i < cap.packets.length; i++) {
    const raw = cap.packets[i]!;
    const d = decodePacket(raw, frags);
    pkts[i] = d;
    if (d.bad) {
      if (d.proto.startsWith('Link ')) unsupported++;
      else malformed++;
    }
    if (raw.time > 0) {
      if (raw.time < first) first = raw.time;
      if (raw.time > last) last = raw.time;
    }
  }
  const streams = buildStreams(pkts);
  for (const s of streams) classifyStream(s);
  const ftp = findFtpTransfers(streams);
  for (const t of ftp) t.data.proto = 'FTP-DATA';
  for (const p of pkts) {
    const s = p.stream >= 0 ? streams[p.stream] : undefined;
    if (s && p.transport === 'tcp' && p.payload.length) p.proto = s.proto;
  }

  const http = lazy(() => httpExchanges(streams));
  const dns = lazy(() => dnsEvents(pkts, streams));
  return {
    cap,
    pkts,
    streams,
    firstTime: Number.isFinite(first) ? first : 0,
    lastTime: Number.isFinite(last) ? last : 0,
    malformed,
    unsupported,
    http,
    dns,
    credentials: lazy(() => {
      const out: Credential[] = [];
      for (const s of streams) out.push(...cleartextCredentials(s));
      for (const x of http()) {
        if (x.request) out.push(...httpCredentials(x.request, x.server, x.stream));
      }
      return out;
    }),
    ftp,
    sni: lazy(() =>
      streams.flatMap((s) => {
        const name = s.proto === 'TLS' ? tlsSni(s.c2s) : null;
        return name
          ? [
              {
                stream: s.index,
                client: `${s.clientIp}:${s.clientPort}`,
                server: `${s.serverIp}:${s.serverPort}`,
                name,
              },
            ]
          : [];
      }),
    ),
  };
}

function httpExchanges(streams: Stream[]): HttpExchange[] {
  const out: HttpExchange[] = [];
  for (const s of streams) {
    if (s.proto !== 'HTTP') continue;
    const reqs = parseHttpStream(s.c2s, 'request');
    const resps = parseHttpStream(
      s.s2c,
      'response',
      reqs.map((r) => r.method),
    ).filter((r) => r.status >= 200 || r.status === 101);
    const n = Math.max(reqs.length, resps.length);
    const server = `${s.serverIp}:${s.serverPort}`;
    for (let i = 0; i < n; i++) {
      const request = reqs[i] ?? null;
      out.push({
        stream: s.index,
        time: s.firstTime,
        host: (request && headerOf(request, 'host')) || s.serverIp,
        server,
        request,
        response: resps[i] ?? null,
      });
    }
  }
  return out;
}

function dnsEvents(pkts: Decoded[], streams: Stream[]): DnsEvent[] {
  const out: DnsEvent[] = [];
  for (const p of pkts) {
    if (p.dns) out.push({ no: p.no, time: p.time, src: p.src, dst: p.dst, msg: p.dns });
  }
  for (const s of streams) {
    if (s.transport !== 'TCP' || s.proto !== 'DNS') continue;
    for (const [dir, data] of [
      [0, s.c2s],
      [1, s.s2c],
    ] as const) {
      let o = 0;
      while (o + 2 <= data.length) {
        const len = u16be(data, o);
        const msg = parseDns(data.subarray(o + 2, o + 2 + len));
        if (!msg) break;
        out.push({
          no: s.firstPkt,
          time: s.firstTime,
          src: dir === 0 ? s.clientIp : s.serverIp,
          dst: dir === 0 ? s.serverIp : s.clientIp,
          msg,
        });
        o += 2 + len;
      }
    }
  }
  return out.sort((a, b) => a.no - b.no);
}

// ---------- overview helpers ----------

export interface Conversation {
  a: string;
  b: string;
  proto: string;
  packets: number;
  bytes: number;
}

/** Packets and bytes per transport conversation (both directions together). */
export function conversations(pkts: Decoded[]): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const p of pkts) {
    if (p.bad || !p.transport) continue;
    const ka = p.transport === 'icmp' ? p.src : `${p.src}:${p.sport}`;
    const kb = p.transport === 'icmp' ? p.dst : `${p.dst}:${p.dport}`;
    const [x, y] = ka < kb ? [ka, kb] : [kb, ka];
    const proto = p.transport === 'tcp' ? 'TCP' : p.transport === 'udp' ? 'UDP' : p.proto;
    const key = `${proto}|${x}|${y}`;
    const c = map.get(key);
    if (c) {
      c.packets++;
      c.bytes += p.len;
    } else map.set(key, { a: x, b: y, proto, packets: 1, bytes: p.len });
  }
  return [...map.values()].sort((m, n) => n.bytes - m.bytes || n.packets - m.packets);
}

export interface ProtoCount {
  proto: string;
  packets: number;
  bytes: number;
}

export function protocolHistogram(pkts: Decoded[]): ProtoCount[] {
  const map = new Map<string, ProtoCount>();
  for (const p of pkts) {
    const c = map.get(p.proto);
    if (c) {
      c.packets++;
      c.bytes += p.len;
    } else map.set(p.proto, { proto: p.proto, packets: 1, bytes: p.len });
  }
  return [...map.values()].sort((a, b) => b.packets - a.packets || a.proto.localeCompare(b.proto));
}
