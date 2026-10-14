import { joinBytes } from './_pcap-addr';
import { TCP_PORTS, type Decoded } from './_pcap-decode';

/** One uninterrupted run of bytes sent in one direction. */
export interface Block {
  /** 0 = client to server, 1 = server to client. */
  dir: 0 | 1;
  data: Uint8Array;
  /** Bytes that were never captured right before this block (lost or filtered packets). */
  gapBefore: number;
}

export interface Stream {
  /** Wireshark-style number (tcp.stream): TCP streams first, then UDP flows. */
  index: number;
  transport: 'TCP' | 'UDP';
  clientIp: string;
  clientPort: number;
  serverIp: string;
  serverPort: number;
  /** Application protocol, filled in by classifyStream (HTTP, FTP, TLS, ...). */
  proto: string;
  /** Number of the first packet of the stream. */
  firstPkt: number;
  packets: number;
  /** Payload bytes in both directions after reassembly. */
  bytes: number;
  firstTime: number;
  lastTime: number;
  syn: boolean;
  fin: boolean;
  rst: boolean;
  retransmits: number;
  /** Numbers of the packets that carried data already seen. */
  retransmitted: Set<number>;
  outOfOrder: number;
  missingBytes: number;
  blocks: Block[];
  /** Everything the client sent / the server sent, concatenated in order. */
  c2s: Uint8Array;
  s2c: Uint8Array;
}

interface Seg {
  seq: number;
  data: Uint8Array;
  pkt: number;
}

interface Side {
  segs: Seg[];
  synSeq: number | null;
}

interface Work {
  id: number;
  /** Endpoint "a" is whoever sent the first packet; side[0] is a to b. */
  a: { ip: string; port: number };
  b: { ip: string; port: number };
  sides: [Side, Side];
  synFrom: 0 | 1 | null;
  synAckFrom: 0 | 1 | null;
  packets: number;
  firstPkt: number;
  hasData: boolean;
  fin: boolean;
  rst: boolean;
  firstTime: number;
  lastTime: number;
}

interface Chunk {
  data: Uint8Array;
  /** Packet number at which this data became available in order. */
  avail: number;
  gap: number;
}

interface Assembled {
  chunks: Chunk[];
  retransmits: number;
  retransPkts: number[];
  outOfOrder: number;
  missing: number;
}

/**
 * Put the segments of one direction in sequence-number order. Duplicates and retransmissions
 * are dropped (the first copy wins), overlaps are trimmed, holes are reported as gaps.
 */
function assemble(side: Side): Assembled {
  const res: Assembled = { chunks: [], retransmits: 0, retransPkts: [], outOfOrder: 0, missing: 0 };
  const segs = side.segs;
  if (!segs.length) return res;
  const ref = side.synSeq !== null ? (side.synSeq + 1) >>> 0 : segs[0]!.seq;
  const rel = segs.map((s) => (s.seq - ref) | 0);
  let base = 0;
  if (side.synSeq === null) {
    base = rel[0]!;
    for (const r of rel) if (r < base) base = r;
  }
  const order = segs.map((_, i) => i);
  let sorted = true;
  for (let i = 1; i < order.length && sorted; i++) sorted = rel[i]! >= rel[i - 1]!;
  if (!sorted) order.sort((x, y) => rel[x]! - rel[y]! || x - y);

  let next = base;
  let maxPkt = 0;
  for (const i of order) {
    const s = segs[i]!;
    let o = rel[i]!;
    let data = s.data;
    if (o + data.length <= next) {
      res.retransmits++;
      res.retransPkts.push(s.pkt);
      continue;
    }
    let gap = 0;
    if (o < next) {
      data = data.subarray(next - o);
      o = next;
    } else if (o > next) {
      gap = o - next;
      res.missing += gap;
    }
    if (s.pkt < maxPkt) res.outOfOrder++;
    maxPkt = Math.max(maxPkt, s.pkt);
    res.chunks.push({ data, avail: maxPkt, gap });
    next = o + data.length;
  }
  return res;
}

/** Interleave both directions by the moment their data became available. */
function mergeBlocks(c2s: Chunk[], s2c: Chunk[]): Block[] {
  const blocks: Block[] = [];
  let parts: Uint8Array[] = [];
  let cur: { dir: 0 | 1; gap: number } | null = null;
  const flush = () => {
    if (cur && parts.length)
      blocks.push({ dir: cur.dir, data: joinBytes(parts), gapBefore: cur.gap });
    parts = [];
  };
  let i = 0;
  let j = 0;
  while (i < c2s.length || j < s2c.length) {
    const takeClient = j >= s2c.length || (i < c2s.length && c2s[i]!.avail <= s2c[j]!.avail);
    const dir: 0 | 1 = takeClient ? 0 : 1;
    const ch = takeClient ? c2s[i++]! : s2c[j++]!;
    if (!cur || cur.dir !== dir || ch.gap > 0) {
      flush();
      cur = { dir, gap: ch.gap };
    }
    parts.push(ch.data);
  }
  flush();
  return blocks;
}

const LOW_SERVER_PORTS = new Set([3306, 5432, 6379, 27017, 9000, 5000, 5001, 8443, 1337, 4444]);

/** Without a SYN, guess who the client is: the side with the "service" port is the server. */
function guessClientIsA(w: Work): boolean {
  const pa = w.a.port;
  const pb = w.b.port;
  const known = (p: number) => TCP_PORTS[p] !== undefined || LOW_SERVER_PORTS.has(p);
  if (known(pa) !== known(pb)) return known(pb);
  if (pa < 1024 !== pb < 1024) return pb < 1024;
  return true;
}

function finish(w: Work, index: number): Stream {
  let clientIsA: boolean;
  if (w.synFrom !== null) clientIsA = w.synFrom === 0;
  else if (w.synAckFrom !== null) clientIsA = w.synAckFrom === 1;
  else clientIsA = guessClientIsA(w);
  const cSide = w.sides[clientIsA ? 0 : 1];
  const sSide = w.sides[clientIsA ? 1 : 0];
  const ca = assemble(cSide);
  const sa = assemble(sSide);
  const client = clientIsA ? w.a : w.b;
  const server = clientIsA ? w.b : w.a;
  const c2s = joinBytes(ca.chunks.map((c) => c.data));
  const s2c = joinBytes(sa.chunks.map((c) => c.data));
  return {
    index,
    transport: 'TCP',
    clientIp: client.ip,
    clientPort: client.port,
    serverIp: server.ip,
    serverPort: server.port,
    proto: 'TCP',
    firstPkt: w.firstPkt,
    packets: w.packets,
    bytes: c2s.length + s2c.length,
    firstTime: w.firstTime,
    lastTime: w.lastTime,
    syn: w.synFrom !== null,
    fin: w.fin,
    rst: w.rst,
    retransmits: ca.retransmits + sa.retransmits,
    retransmitted: new Set([...ca.retransPkts, ...sa.retransPkts]),
    outOfOrder: ca.outOfOrder + sa.outOfOrder,
    missingBytes: ca.missing + sa.missing,
    blocks: mergeBlocks(ca.chunks, sa.chunks),
    c2s,
    s2c,
  };
}

function buildTcp(pkts: Decoded[]): Stream[] {
  const active = new Map<string, Work>();
  const all: Work[] = [];
  for (const p of pkts) {
    const t = p.tcp;
    if (!t || p.bad) continue;
    const ka = `${p.src}:${p.sport}`;
    const kb = `${p.dst}:${p.dport}`;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    let w = active.get(key);
    const syn = (t.flags & 0x12) === 0x02;
    if (w && syn) {
      const side = w.sides[w.a.ip === p.src && w.a.port === p.sport ? 0 : 1];
      // A SYN on a used connection (or with another ISN) is a new connection reusing the ports.
      if (w.hasData || w.fin || w.rst || (side.synSeq !== null && side.synSeq !== t.seq))
        w = undefined;
    }
    if (!w) {
      w = {
        id: all.length,
        a: { ip: p.src, port: p.sport },
        b: { ip: p.dst, port: p.dport },
        sides: [
          { segs: [], synSeq: null },
          { segs: [], synSeq: null },
        ],
        synFrom: null,
        synAckFrom: null,
        packets: 0,
        firstPkt: p.no,
        hasData: false,
        fin: false,
        rst: false,
        firstTime: p.time,
        lastTime: p.time,
      };
      active.set(key, w);
      all.push(w);
    }
    const dir: 0 | 1 = w.a.ip === p.src && w.a.port === p.sport ? 0 : 1;
    p.stream = w.id;
    w.packets++;
    w.lastTime = p.time;
    const side = w.sides[dir];
    if (t.flags & 0x02) {
      side.synSeq = t.seq;
      if (t.flags & 0x10) w.synAckFrom ??= dir;
      else w.synFrom ??= dir;
    }
    if (t.flags & 0x01) w.fin = true;
    if (t.flags & 0x04) w.rst = true;
    if (p.payload.length) {
      w.hasData = true;
      side.segs.push({ seq: t.seq, data: p.payload, pkt: p.no });
    }
  }
  return all.map((w, i) => finish(w, i));
}

function buildUdp(pkts: Decoded[], firstIndex: number): Stream[] {
  interface UWork {
    id: number;
    client: { ip: string; port: number };
    server: { ip: string; port: number };
    packets: number;
    firstPkt: number;
    first: number;
    last: number;
    parts: { dir: 0 | 1; data: Uint8Array }[];
  }
  const flows = new Map<string, UWork>();
  const order: UWork[] = [];
  for (const p of pkts) {
    if (p.transport !== 'udp' || p.bad || p.proto !== 'UDP' || !p.payload.length) continue;
    const ka = `${p.src}:${p.sport}`;
    const kb = `${p.dst}:${p.dport}`;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    let w = flows.get(key);
    if (!w) {
      w = {
        id: order.length,
        client: { ip: p.src, port: p.sport },
        server: { ip: p.dst, port: p.dport },
        packets: 0,
        firstPkt: p.no,
        first: p.time,
        last: p.time,
        parts: [],
      };
      flows.set(key, w);
      order.push(w);
    }
    w.packets++;
    w.last = p.time;
    p.stream = firstIndex + w.id;
    w.parts.push({
      dir: w.client.ip === p.src && w.client.port === p.sport ? 0 : 1,
      data: p.payload,
    });
  }
  return order.map((w, i) => {
    const blocks: Block[] = [];
    let run: Uint8Array[] = [];
    let runDir: 0 | 1 = 0;
    const flush = () => {
      if (run.length) blocks.push({ dir: runDir, data: joinBytes(run), gapBefore: 0 });
      run = [];
    };
    for (const part of w.parts) {
      if (part.dir !== runDir) {
        flush();
        runDir = part.dir;
      }
      run.push(part.data);
    }
    flush();
    const c2s = joinBytes(blocks.filter((b) => b.dir === 0).map((b) => b.data));
    const s2c = joinBytes(blocks.filter((b) => b.dir === 1).map((b) => b.data));
    return {
      index: firstIndex + i,
      transport: 'UDP' as const,
      clientIp: w.client.ip,
      clientPort: w.client.port,
      serverIp: w.server.ip,
      serverPort: w.server.port,
      proto: 'UDP',
      firstPkt: w.firstPkt,
      packets: w.packets,
      bytes: c2s.length + s2c.length,
      firstTime: w.first,
      lastTime: w.last,
      syn: false,
      fin: false,
      rst: false,
      retransmits: 0,
      retransmitted: new Set<number>(),
      outOfOrder: 0,
      missingBytes: 0,
      blocks,
      c2s,
      s2c,
    };
  });
}

/** TCP connections (reassembled) followed by UDP flows. Sets `stream` on each decoded packet. */
export function buildStreams(pkts: Decoded[]): Stream[] {
  const tcp = buildTcp(pkts);
  return [...tcp, ...buildUdp(pkts, tcp.length)];
}
