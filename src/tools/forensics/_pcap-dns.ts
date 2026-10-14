import { toHex, u16be, u32be } from '../../lib/bytes';
import { fmtIPv4, fmtIPv6 } from './_pcap-addr';

export interface DnsQuestion {
  name: string;
  type: number;
}

export interface DnsRecord {
  name: string;
  type: number;
  ttl: number;
  /** Human-readable RDATA ("93.184.216.34", "mail.example.org", "v=spf1 ..."). */
  data: string;
}

export interface DnsMessage {
  id: number;
  response: boolean;
  opcode: number;
  rcode: number;
  questions: DnsQuestion[];
  answers: DnsRecord[];
}

const TYPES: Record<number, string> = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  10: 'NULL',
  12: 'PTR',
  13: 'HINFO',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
  41: 'OPT',
  43: 'DS',
  46: 'RRSIG',
  47: 'NSEC',
  48: 'DNSKEY',
  52: 'TLSA',
  64: 'SVCB',
  65: 'HTTPS',
  99: 'SPF',
  252: 'AXFR',
  255: 'ANY',
};

const RCODES = ['No error', 'Format error', 'Server failure', 'No such name', 'Not implemented'];

export const dnsTypeName = (t: number): string => TYPES[t] ?? `TYPE${t}`;
export const dnsRcodeName = (c: number): string => RCODES[c] ?? `rcode ${c}`;

const latin1 = (b: Uint8Array, from: number, to: number): string => {
  let s = '';
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]!);
  return s;
};

/** Read a (possibly compressed) domain name. Returns null on a loop or out-of-range pointer. */
function readName(b: Uint8Array, start: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let pos = start;
  let next = -1;
  let hops = 0;
  let total = 0;
  for (;;) {
    if (pos >= b.length) return null;
    const l = b[pos]!;
    if (l === 0) {
      pos++;
      break;
    }
    if ((l & 0xc0) === 0xc0) {
      if (pos + 1 >= b.length || ++hops > 32) return null;
      if (next < 0) next = pos + 2;
      pos = ((l & 0x3f) << 8) | b[pos + 1]!;
      continue;
    }
    if (l & 0xc0) return null; // reserved label types
    if (pos + 1 + l > b.length) return null;
    total += l + 1;
    if (total > 255) return null;
    labels.push(latin1(b, pos + 1, pos + 1 + l));
    pos += 1 + l;
  }
  return { name: labels.length ? labels.join('.') : '.', next: next < 0 ? pos : next };
}

function rdata(b: Uint8Array, type: number, off: number, len: number): string {
  const end = off + len;
  switch (type) {
    case 1:
      if (len === 4) return fmtIPv4(b, off);
      break;
    case 28:
      if (len === 16) return fmtIPv6(b, off);
      break;
    case 2:
    case 5:
    case 12: {
      const n = readName(b, off);
      if (n) return n.name;
      break;
    }
    case 15: {
      const n = readName(b, off + 2);
      if (n && len >= 3) return `${u16be(b, off)} ${n.name}`;
      break;
    }
    case 33: {
      const n = readName(b, off + 6);
      if (n && len >= 7)
        return `${u16be(b, off)} ${u16be(b, off + 2)} ${u16be(b, off + 4)} ${n.name}`;
      break;
    }
    case 6: {
      const m = readName(b, off);
      const r = m ? readName(b, m.next) : null;
      if (m && r && r.next + 4 <= end) return `${m.name} ${r.name} serial ${u32be(b, r.next)}`;
      break;
    }
    case 16:
    case 99: {
      let s = '';
      let p = off;
      while (p < end) {
        const l = b[p]!;
        s += latin1(b, p + 1, Math.min(end, p + 1 + l));
        p += 1 + l;
      }
      return s;
    }
  }
  return toHex(b.subarray(off, Math.min(end, off + 48)));
}

/**
 * Decode a DNS message (UDP payload, or a TCP message without its 2-byte length).
 * Returns null unless the bytes are structurally a DNS message, so it doubles as a detector.
 */
export function parseDns(b: Uint8Array): DnsMessage | null {
  if (b.length < 12) return null;
  const flags = u16be(b, 2);
  const opcode = (flags >> 11) & 15;
  const qd = u16be(b, 4);
  const an = u16be(b, 6);
  const ns = u16be(b, 8);
  const ar = u16be(b, 10);
  if (opcode > 5 || qd > 64 || an + ns + ar > 512 || qd + an === 0) return null;
  const msg: DnsMessage = {
    id: u16be(b, 0),
    response: (flags & 0x8000) !== 0,
    opcode,
    rcode: flags & 15,
    questions: [],
    answers: [],
  };
  let o = 12;
  for (let i = 0; i < qd; i++) {
    const n = readName(b, o);
    if (!n || n.next + 4 > b.length) return null;
    msg.questions.push({ name: n.name, type: u16be(b, n.next) });
    o = n.next + 4;
  }
  for (let i = 0; i < an; i++) {
    const n = readName(b, o);
    if (!n || n.next + 10 > b.length) break; // keep what we have: answers are best effort
    const type = u16be(b, n.next);
    const ttl = u32be(b, n.next + 4);
    const len = u16be(b, n.next + 8);
    const start = n.next + 10;
    if (start + len > b.length) break;
    msg.answers.push({ name: n.name, type, ttl, data: rdata(b, type, start, len) });
    o = start + len;
  }
  return msg;
}

/** "Standard query 0x1a2b A example.com" / "Standard query response 0x1a2b A example.com A 1.2.3.4". */
export function dnsInfo(m: DnsMessage): string {
  const q = m.questions[0];
  const head = m.opcode === 0 ? 'Standard query' : `DNS opcode ${m.opcode}`;
  const id = `0x${m.id.toString(16).padStart(4, '0')}`;
  const question = q ? ` ${dnsTypeName(q.type)} ${q.name}` : '';
  if (!m.response) return `${head} ${id}${question}`;
  const ans = m.answers.map((a) => `${dnsTypeName(a.type)} ${a.data}`).join(', ');
  const rc = m.rcode ? ` ${dnsRcodeName(m.rcode)}` : '';
  return `${head} response ${id}${rc}${question}${ans ? ` ${ans}` : ''}`;
}
