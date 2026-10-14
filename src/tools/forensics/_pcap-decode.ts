import { u16be, u16le, u32be, u32le } from '../../lib/bytes';
import { fmtIPv4, fmtIPv6, fmtMac } from './_pcap-addr';
import { parseDns, type DnsMessage } from './_pcap-dns';
import type { RawPacket } from './_pcap-read';

export interface TcpInfo {
  seq: number;
  ack: number;
  flags: number;
  win: number;
}

export interface IcmpInfo {
  v6: boolean;
  type: number;
  code: number;
  /** Echo identifier and sequence (0 for other message types). */
  id: number;
  seq: number;
  isEcho: boolean;
  isRequest: boolean;
}

export interface ArpInfo {
  op: number;
  sha: string;
  spa: string;
  tha: string;
  tpa: string;
}

export interface Decoded {
  no: number;
  /** Seconds since the epoch. */
  time: number;
  /** Bytes on the wire. */
  len: number;
  /** Bytes actually stored in the capture. */
  capLen: number;
  /** Highest recognised protocol: "TCP", "HTTP", "DNS", "ARP", "ICMP"... */
  proto: string;
  /** IP addresses, or MAC addresses for frames without an IP layer. */
  src: string;
  dst: string;
  sport: number;
  dport: number;
  /** Transport layer, if any. */
  transport: 'tcp' | 'udp' | 'icmp' | null;
  ttl: number;
  tcp?: TcpInfo;
  icmp?: IcmpInfo;
  arp?: ArpInfo;
  dns?: DnsMessage;
  /** Transport payload (TCP/UDP data, ICMP echo data). */
  payload: Uint8Array;
  /** Set when the layer text is already known (ARP, ICMP, 802.11, fragments...). */
  info: string;
  /** True when the frame is too short or damaged to be decoded. */
  bad: boolean;
  /** Stream number (TCP or UDP flow) once the streams are built, otherwise -1. */
  stream: number;
}

const TCP_FLAGS: [number, string][] = [
  [0x01, 'FIN'],
  [0x02, 'SYN'],
  [0x04, 'RST'],
  [0x08, 'PSH'],
  [0x10, 'ACK'],
  [0x20, 'URG'],
  [0x40, 'ECE'],
  [0x80, 'CWR'],
];

export const tcpFlagNames = (f: number): string =>
  TCP_FLAGS.filter(([bit]) => f & bit)
    .map(([, n]) => n)
    .join(', ');

const UDP_PORTS: Record<number, string> = {
  53: 'DNS',
  67: 'DHCP',
  68: 'DHCP',
  69: 'TFTP',
  123: 'NTP',
  137: 'NBNS',
  138: 'NBDS',
  161: 'SNMP',
  162: 'SNMP',
  500: 'ISAKMP',
  514: 'Syslog',
  1900: 'SSDP',
  5353: 'MDNS',
  5355: 'LLMNR',
};

/** Well-known TCP ports -> application protocol. Used as a hint when nothing better is known. */
export const TCP_PORTS: Record<number, string> = {
  20: 'FTP-DATA',
  21: 'FTP',
  22: 'SSH',
  23: 'Telnet',
  25: 'SMTP',
  53: 'DNS',
  80: 'HTTP',
  110: 'POP',
  143: 'IMAP',
  443: 'TLS',
  445: 'SMB',
  465: 'TLS',
  587: 'SMTP',
  993: 'TLS',
  995: 'TLS',
  3389: 'RDP',
  8000: 'HTTP',
  8008: 'HTTP',
  8080: 'HTTP',
  8888: 'HTTP',
};

const IP_PROTOS: Record<number, string> = {
  2: 'IGMP',
  47: 'GRE',
  50: 'ESP',
  51: 'AH',
  89: 'OSPF',
  103: 'PIM',
  112: 'VRRP',
  132: 'SCTP',
};

const ETHERTYPES: Record<number, string> = {
  0x0842: 'WoL',
  0x8035: 'RARP',
  0x8863: 'PPPoE',
  0x8864: 'PPPoE',
  0x888e: 'EAPOL',
  0x88cc: 'LLDP',
  0x88e5: 'MACsec',
};

const EMPTY = new Uint8Array(0);

/** Link-layer result: where the network layer starts and what it is. */
interface Link {
  ethertype: number;
  off: number;
  src: string;
  dst: string;
  /** Frame that carries no network layer we can follow (management frames, STP...). */
  proto?: string;
  info?: string;
}

const ET_IPV4 = 0x0800;
const ET_ARP = 0x0806;
const ET_IPV6 = 0x86dd;

function etherFromIpVersion(b: Uint8Array, off: number): number {
  const v = (b[off] ?? 0) >> 4;
  return v === 4 ? ET_IPV4 : v === 6 ? ET_IPV6 : 0;
}

const mac = (b: Uint8Array, o: number): string =>
  b[o] === 0xff && b[o + 1] === 0xff && b[o + 2] === 0xff && b[o + 5] === 0xff
    ? 'Broadcast'
    : fmtMac(b, o);

function decodeEthernet(b: Uint8Array, off0 = 0): Link | null {
  if (b.length < off0 + 14) return null;
  let off = off0 + 14;
  let et = u16be(b, off0 + 12);
  for (let i = 0; i < 3 && (et === 0x8100 || et === 0x88a8 || et === 0x9100); i++) {
    if (off + 4 > b.length) return null;
    et = u16be(b, off + 2);
    off += 4;
  }
  if (et <= 1500) {
    // IEEE 802.3 length field: LLC/SNAP carries the real ethertype
    if (b[off] === 0xaa && b[off + 1] === 0xaa && b[off + 2] === 3 && off + 8 <= b.length) {
      et = u16be(b, off + 6);
      off += 8;
    } else {
      return {
        ethertype: 0,
        off,
        src: mac(b, off0 + 6),
        dst: mac(b, off0),
        proto: b[off] === 0x42 && b[off + 1] === 0x42 ? 'STP' : 'LLC',
        info: 'IEEE 802.3 frame',
      };
    }
  }
  return { ethertype: et, off, src: mac(b, off0 + 6), dst: mac(b, off0) };
}

function ssid(b: Uint8Array, from: number): string | null {
  let o = from;
  while (o + 2 <= b.length) {
    const id = b[o]!;
    const l = b[o + 1]!;
    if (o + 2 + l > b.length) return null;
    if (id === 0) {
      let s = '';
      for (let i = 0; i < l; i++) s += String.fromCharCode(b[o + 2 + i]!);
      return s;
    }
    o += 2 + l;
  }
  return null;
}

const WLAN_MGMT = [
  'Association Request',
  'Association Response',
  'Reassociation Request',
  'Reassociation Response',
  'Probe Request',
  'Probe Response',
  'Timing Advertisement',
  'Reserved',
  'Beacon',
  'ATIM',
  'Disassociation',
  'Authentication',
  'Deauthentication',
  'Action',
];
const WLAN_CTRL: Record<number, string> = {
  8: 'Block Ack Request',
  9: 'Block Ack',
  10: 'PS-Poll',
  11: 'RTS',
  12: 'CTS',
  13: 'Acknowledgement',
};

/** IEEE 802.11 frame, starting at `off`. Data frames with LLC/SNAP lead to the IP layer. */
function decodeWlan(b: Uint8Array, off: number): Link | null {
  if (off + 10 > b.length) return null;
  const fc0 = b[off]!;
  const fc1 = b[off + 1]!;
  const type = (fc0 >> 2) & 3;
  const sub = fc0 >> 4;
  const a1 = mac(b, off + 4);
  if (type === 1) {
    const name = WLAN_CTRL[sub] ?? `Control frame (${sub})`;
    const hasTa = [8, 9, 10, 11].includes(sub) && off + 16 <= b.length;
    return {
      ethertype: 0,
      off,
      src: hasTa ? mac(b, off + 10) : '',
      dst: a1,
      proto: '802.11',
      info: name,
    };
  }
  if (off + 24 > b.length) return null;
  const a2 = mac(b, off + 10);
  const a3 = mac(b, off + 16);
  if (type === 0) {
    const name = WLAN_MGMT[sub] ?? `Management frame (${sub})`;
    let info = name;
    if (sub === 8 || sub === 5) info += `, SSID="${ssid(b, off + 24 + 12) ?? ''}"`;
    if (sub === 4) info += `, SSID="${ssid(b, off + 24) ?? ''}"`;
    return { ethertype: 0, off, src: a2, dst: a1, proto: '802.11', info };
  }
  if (type !== 2)
    return { ethertype: 0, off, src: a2, dst: a1, proto: '802.11', info: 'Extension frame' };
  const toDs = (fc1 & 1) !== 0;
  const fromDs = (fc1 & 2) !== 0;
  let hdr = toDs && fromDs ? 30 : 24;
  if (sub & 8) hdr += 2; // QoS control
  if (fc1 & 0x80) hdr += 4; // HT control (+HTC/Order)
  const dst = toDs ? a3 : a1;
  const src = toDs && fromDs && off + 30 <= b.length ? mac(b, off + 24) : fromDs && !toDs ? a3 : a2;
  const base = { src, dst, proto: '802.11', ethertype: 0, off };
  if (fc1 & 0x40) return { ...base, info: 'Data (protected: WEP/WPA, payload is encrypted)' };
  if (sub & 4) return { ...base, info: 'Null function (no data)' };
  const p = off + hdr;
  if (b[p] === 0xaa && b[p + 1] === 0xaa && b[p + 2] === 3 && p + 8 <= b.length) {
    return { src, dst, ethertype: u16be(b, p + 6), off: p + 8 };
  }
  return { ...base, info: 'Data' };
}

const NULL_FAMILIES_V6 = new Set([10, 24, 28, 30]);

function decodeLink(raw: RawPacket): Link | null {
  const b = raw.data;
  switch (raw.link) {
    case 1:
      return decodeEthernet(b);
    case 0:
    case 108: {
      if (b.length < 4) return null;
      const le = u32le(b, 0);
      const fam = raw.link === 108 ? u32be(b, 0) : le <= 0xff ? le : u32be(b, 0);
      return {
        ethertype: fam === 2 ? ET_IPV4 : NULL_FAMILIES_V6.has(fam) ? ET_IPV6 : 0,
        off: 4,
        src: '',
        dst: '',
      };
    }
    case 12:
    case 14:
    case 101:
      return { ethertype: etherFromIpVersion(b, 0), off: 0, src: '', dst: '' };
    case 228:
      return { ethertype: ET_IPV4, off: 0, src: '', dst: '' };
    case 229:
      return { ethertype: ET_IPV6, off: 0, src: '', dst: '' };
    case 113: {
      if (b.length < 16) return null;
      const alen = Math.min(u16be(b, 4), 8);
      const sm = alen === 6 ? fmtMac(b, 6) : '';
      return { ethertype: u16be(b, 14), off: 16, src: sm, dst: '' };
    }
    case 276: {
      if (b.length < 20) return null;
      const alen = Math.min(b[11]!, 8);
      const sm = alen === 6 ? fmtMac(b, 12) : '';
      return { ethertype: u16be(b, 0), off: 20, src: sm, dst: '' };
    }
    case 105:
      return decodeWlan(b, 0);
    case 127: {
      // Radiotap header: little-endian length at offset 2
      if (b.length < 8) return null;
      return decodeWlan(b, u16le(b, 2));
    }
    default:
      return null;
  }
}

export const LINK_NAMES: Record<number, string> = {
  0: 'Null/Loopback',
  1: 'Ethernet',
  12: 'Raw IP',
  14: 'Raw IP',
  101: 'Raw IP',
  105: 'IEEE 802.11',
  108: 'OpenBSD loopback',
  113: 'Linux cooked (SLL)',
  127: '802.11 + radiotap',
  228: 'Raw IPv4',
  229: 'Raw IPv6',
  276: 'Linux cooked v2 (SLL2)',
};

// ---------- IPv4 fragment reassembly ----------

interface FragSet {
  parts: { off: number; data: Uint8Array }[];
  total: number;
}

/** Collects IPv4 fragments; keyed by src/dst/id/protocol. One table per capture. */
export class FragmentTable {
  private sets = new Map<string, FragSet>();

  /** Add a fragment. Returns the whole datagram payload once every piece has arrived. */
  add(key: string, off: number, more: boolean, data: Uint8Array): Uint8Array | null {
    let set = this.sets.get(key);
    if (!set) {
      set = { parts: [], total: -1 };
      this.sets.set(key, set);
    }
    set.parts.push({ off, data });
    if (!more) set.total = off + data.length;
    if (set.total < 0 || set.total > 0x10000) return null;
    const sorted = [...set.parts].sort((a, c) => a.off - c.off);
    let next = 0;
    for (const p of sorted) {
      if (p.off > next) return null;
      next = Math.max(next, p.off + p.data.length);
    }
    if (next < set.total) return null;
    const out = new Uint8Array(set.total);
    for (const p of sorted) out.set(p.data.subarray(0, Math.max(0, set.total - p.off)), p.off);
    this.sets.delete(key);
    return out;
  }
}

// ---------- transport ----------

interface Net {
  src: string;
  dst: string;
  ttl: number;
  proto: number;
  /** Bytes after the IP header, already cut to the IP length. */
  body: Uint8Array;
  v6: boolean;
}

const ICMP4_NAMES: Record<number, string> = {
  0: 'Echo (ping) reply',
  3: 'Destination unreachable',
  4: 'Source quench',
  5: 'Redirect',
  8: 'Echo (ping) request',
  9: 'Router advertisement',
  10: 'Router solicitation',
  11: 'Time-to-live exceeded',
  12: 'Parameter problem',
  13: 'Timestamp request',
  14: 'Timestamp reply',
};
const ICMP6_NAMES: Record<number, string> = {
  1: 'Destination unreachable',
  2: 'Packet too big',
  3: 'Time exceeded',
  128: 'Echo (ping) request',
  129: 'Echo (ping) reply',
  133: 'Router solicitation',
  134: 'Router advertisement',
  135: 'Neighbor solicitation',
  136: 'Neighbor advertisement',
};

function icmpInfo(d: Decoded, i: IcmpInfo): string {
  const names = i.v6 ? ICMP6_NAMES : ICMP4_NAMES;
  const name = names[i.type] ?? `ICMP type ${i.type}`;
  if (i.isEcho) {
    return `${name}  id=0x${i.id.toString(16).padStart(4, '0')}, seq=${i.seq}, ttl=${d.ttl}`;
  }
  return i.code ? `${name} (code ${i.code})` : name;
}

function decodeTransport(d: Decoded, net: Net): void {
  const b = net.body;
  d.src = net.src;
  d.dst = net.dst;
  d.ttl = net.ttl;
  if (net.proto === 6) {
    d.proto = 'TCP';
    d.transport = 'tcp';
    if (b.length < 20) {
      d.bad = true;
      return;
    }
    const off = (b[12]! >> 4) * 4;
    if (off < 20 || off > b.length) {
      d.bad = true;
      return;
    }
    d.sport = u16be(b, 0);
    d.dport = u16be(b, 2);
    d.tcp = { seq: u32be(b, 4), ack: u32be(b, 8), flags: b[13]!, win: u16be(b, 14) };
    d.payload = b.subarray(off);
    return;
  }
  if (net.proto === 17) {
    d.proto = 'UDP';
    d.transport = 'udp';
    if (b.length < 8) {
      d.bad = true;
      return;
    }
    d.sport = u16be(b, 0);
    d.dport = u16be(b, 2);
    const ulen = u16be(b, 4);
    d.payload = b.subarray(8, ulen >= 8 ? Math.min(ulen, b.length) : b.length);
    const hint = UDP_PORTS[d.dport] ?? UDP_PORTS[d.sport];
    if (hint) {
      d.proto = hint;
      if (hint === 'DNS' || hint === 'MDNS' || hint === 'LLMNR') {
        const m = parseDns(d.payload);
        if (m) d.dns = m;
        else d.proto = 'UDP';
      }
    }
    return;
  }
  if ((net.proto === 1 && !net.v6) || (net.proto === 58 && net.v6)) {
    d.proto = net.v6 ? 'ICMPv6' : 'ICMP';
    d.transport = 'icmp';
    if (b.length < 4) {
      d.bad = true;
      return;
    }
    const type = b[0]!;
    const isEcho = net.v6 ? type === 128 || type === 129 : type === 0 || type === 8;
    const info: IcmpInfo = {
      v6: net.v6,
      type,
      code: b[1]!,
      id: isEcho && b.length >= 8 ? u16be(b, 4) : 0,
      seq: isEcho && b.length >= 8 ? u16be(b, 6) : 0,
      isEcho: isEcho && b.length >= 8,
      isRequest: net.v6 ? type === 128 : type === 8,
    };
    d.icmp = info;
    d.payload = info.isEcho ? b.subarray(8) : b.subarray(Math.min(4, b.length));
    d.info = icmpInfo(d, info);
    return;
  }
  d.proto = IP_PROTOS[net.proto] ?? (net.v6 ? 'IPv6' : 'IPv4');
  d.info = `${d.proto === 'IPv4' || d.proto === 'IPv6' ? 'IP protocol' : 'Protocol'} ${net.proto}`;
  d.payload = b;
}

const v6Ext = new Set([0, 43, 60]);

/** Decode one captured frame. Never throws: damaged frames come back with `bad` set. */
export function decodePacket(raw: RawPacket, frags: FragmentTable): Decoded {
  const d: Decoded = {
    no: raw.no,
    time: raw.time,
    len: raw.origLen || raw.data.length,
    capLen: raw.data.length,
    proto: 'Unknown',
    src: '',
    dst: '',
    sport: 0,
    dport: 0,
    transport: null,
    ttl: 0,
    payload: EMPTY,
    info: '',
    bad: false,
    stream: -1,
  };
  const link = decodeLink(raw);
  if (!link) {
    d.bad = true;
    d.proto = LINK_NAMES[raw.link] ? 'Malformed' : `Link ${raw.link}`;
    d.info = LINK_NAMES[raw.link]
      ? 'Frame is too short for its link-layer header'
      : `Unsupported link type ${raw.link}`;
    return d;
  }
  d.src = link.src;
  d.dst = link.dst;
  const b = raw.data;
  const off = link.off;
  if (link.proto) {
    d.proto = link.proto;
    d.info = link.info ?? '';
    return d;
  }

  if (link.ethertype === ET_ARP) {
    d.proto = 'ARP';
    if (off + 28 > b.length) {
      d.bad = true;
      return d;
    }
    const op = u16be(b, off + 6);
    const arp: ArpInfo = {
      op,
      sha: fmtMac(b, off + 8),
      spa: fmtIPv4(b, off + 14),
      tha: fmtMac(b, off + 18),
      tpa: fmtIPv4(b, off + 24),
    };
    d.arp = arp;
    d.info =
      arp.spa === arp.tpa
        ? `Gratuitous ARP for ${arp.spa} (${op === 1 ? 'Request' : 'Reply'})`
        : op === 1
          ? `Who has ${arp.tpa}? Tell ${arp.spa}`
          : op === 2
            ? `${arp.spa} is at ${arp.sha}`
            : `ARP opcode ${op}`;
    return d;
  }

  if (link.ethertype === ET_IPV4) {
    if (off + 20 > b.length || b[off]! >> 4 !== 4) {
      d.bad = true;
      d.proto = 'Malformed';
      d.info = 'Truncated IPv4 header';
      return d;
    }
    const ihl = (b[off]! & 15) * 4;
    const total = u16be(b, off + 2);
    if (ihl < 20 || off + ihl > b.length) {
      d.bad = true;
      d.proto = 'Malformed';
      d.info = 'Bad IPv4 header length';
      return d;
    }
    // total length 0 happens with TCP segmentation offload: trust the capture then
    const end = total >= ihl ? Math.min(off + total, b.length) : b.length;
    const net: Net = {
      src: fmtIPv4(b, off + 12),
      dst: fmtIPv4(b, off + 16),
      ttl: b[off + 8]!,
      proto: b[off + 9]!,
      body: b.subarray(off + ihl, end),
      v6: false,
    };
    const ff = u16be(b, off + 6);
    const fragOff = (ff & 0x1fff) * 8;
    const more = (ff & 0x2000) !== 0;
    if (fragOff > 0 || more) {
      const key = `${net.src}|${net.dst}|${u16be(b, off + 4)}|${net.proto}`;
      const whole = frags.add(key, fragOff, more, net.body);
      if (!whole) {
        d.src = net.src;
        d.dst = net.dst;
        d.ttl = net.ttl;
        d.proto = 'IPv4';
        d.info = `Fragmented IP protocol (proto=${net.proto}, off=${fragOff}, ID=${u16be(b, off + 4)
          .toString(16)
          .padStart(4, '0')})`;
        return d;
      }
      net.body = whole;
    }
    decodeTransport(d, net);
    return d;
  }

  if (link.ethertype === ET_IPV6) {
    if (off + 40 > b.length || b[off]! >> 4 !== 6) {
      d.bad = true;
      d.proto = 'Malformed';
      d.info = 'Truncated IPv6 header';
      return d;
    }
    const plen = u16be(b, off + 4);
    const end = plen > 0 ? Math.min(off + 40 + plen, b.length) : b.length;
    let next = b[off + 6]!;
    let p = off + 40;
    for (let i = 0; i < 8 && p + 2 <= end; i++) {
      if (v6Ext.has(next)) {
        const l = (b[p + 1]! + 1) * 8;
        next = b[p]!;
        p += l;
      } else if (next === 51) {
        const l = (b[p + 1]! + 2) * 4;
        next = b[p]!;
        p += l;
      } else break;
    }
    const src = fmtIPv6(b, off + 8);
    const dst = fmtIPv6(b, off + 24);
    if (next === 44) {
      d.src = src;
      d.dst = dst;
      d.proto = 'IPv6';
      d.info = 'Fragmented IPv6 datagram';
      return d;
    }
    if (p > end) {
      d.bad = true;
      d.proto = 'Malformed';
      d.info = 'Truncated IPv6 extension headers';
      return d;
    }
    decodeTransport(d, {
      src,
      dst,
      ttl: b[off + 7]!,
      proto: next,
      body: b.subarray(p, end),
      v6: true,
    });
    return d;
  }

  d.proto =
    ETHERTYPES[link.ethertype] ??
    (link.ethertype ? `Ethernet 0x${link.ethertype.toString(16)}` : 'Unknown');
  d.info = `EtherType 0x${link.ethertype.toString(16).padStart(4, '0')}`;
  return d;
}
