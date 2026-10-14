// Sample captures for the PCAP analyzer. Deterministic, no dependencies.
//   forensics-http.pcap     libpcap: ARP, DNS, an HTTP download whose flag is split across two TCP
//                           segments (one of them retransmitted), a cleartext FTP login and a
//                           passive-mode FTP download.
//   forensics-exfil.pcapng  pcapng with two interfaces: ICMP echo requests whose 4-byte payload
//                           chunks spell a flag, plus ordinary pings on a loopback interface.
// Run: node scripts/gen-samples-pcap.mjs
import { writeFileSync } from 'node:fs';

// ---------- byte helpers ----------

const u16 = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n) => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const ip4 = (s) => Buffer.from(s.split('.').map(Number));
const mac = (s) => Buffer.from(s.split(':').map((x) => parseInt(x, 16)));
const ascii = (s) => Buffer.from(s, 'latin1');

/** Internet checksum (RFC 1071). */
function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2)
    sum += (buf[i] << 8) | (i + 1 < buf.length ? buf[i + 1] : 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

// ---------- protocol builders ----------

let ipId = 0x1000;

function ipv4(src, dst, proto, payload) {
  const head = Buffer.concat([
    Buffer.from([0x45, 0x00]),
    u16(20 + payload.length),
    u16(ipId++),
    u16(0x4000), // don't fragment
    Buffer.from([64, proto]),
    u16(0),
    ip4(src),
    ip4(dst),
  ]);
  head.writeUInt16BE(checksum(head), 10);
  return Buffer.concat([head, payload]);
}

function pseudo(src, dst, proto, len) {
  return Buffer.concat([ip4(src), ip4(dst), Buffer.from([0, proto]), u16(len)]);
}

function tcp(src, dst, sport, dport, seq, ack, flags, payload = Buffer.alloc(0)) {
  const syn = flags & 0x02;
  const options = syn ? Buffer.from([2, 4, 0x05, 0xb4]) : Buffer.alloc(0); // MSS 1460
  const head = Buffer.concat([
    u16(sport),
    u16(dport),
    u32(seq),
    u32(flags & 0x10 ? ack : 0),
    Buffer.from([((20 + options.length) / 4) << 4, flags]),
    u16(64240),
    u16(0),
    u16(0),
    options,
  ]);
  const seg = Buffer.concat([head, payload]);
  const sum = checksum(Buffer.concat([pseudo(src, dst, 6, seg.length), seg]));
  seg.writeUInt16BE(sum, 16);
  return ipv4(src, dst, 6, seg);
}

function udp(src, dst, sport, dport, payload) {
  const seg = Buffer.concat([u16(sport), u16(dport), u16(8 + payload.length), u16(0), payload]);
  const sum = checksum(Buffer.concat([pseudo(src, dst, 17, seg.length), seg])) || 0xffff;
  seg.writeUInt16BE(sum, 6);
  return ipv4(src, dst, 17, seg);
}

function icmpEcho(src, dst, reply, id, seq, payload) {
  const msg = Buffer.concat([Buffer.from([reply ? 0 : 8, 0]), u16(0), u16(id), u16(seq), payload]);
  msg.writeUInt16BE(checksum(msg), 2);
  return ipv4(src, dst, 1, msg);
}

function ethernet(srcMac, dstMac, type, payload) {
  const frame = Buffer.concat([mac(dstMac), mac(srcMac), u16(type), payload]);
  return frame.length < 60 ? Buffer.concat([frame, Buffer.alloc(60 - frame.length)]) : frame;
}

function arp(op, sha, spa, tha, tpa) {
  return Buffer.concat([
    u16(1),
    u16(0x0800),
    Buffer.from([6, 4]),
    u16(op),
    mac(sha),
    ip4(spa),
    mac(tha),
    ip4(tpa),
  ]);
}

function dnsName(name) {
  return Buffer.concat([
    ...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), ascii(l)])),
    Buffer.from([0]),
  ]);
}

function dnsQuery(id, name, type) {
  return Buffer.concat([
    u16(id),
    u16(0x0100),
    u16(1),
    u16(0),
    u16(0),
    u16(0),
    dnsName(name),
    u16(type),
    u16(1),
  ]);
}

function dnsAnswer(id, name, type, address) {
  const answers = address
    ? Buffer.concat([u16(0xc00c), u16(type), u16(1), u32(300), u16(4), ip4(address)])
    : Buffer.alloc(0);
  return Buffer.concat([
    u16(id),
    u16(address ? 0x8180 : 0x8183),
    u16(1),
    u16(address ? 1 : 0),
    u16(0),
    u16(0),
    dnsName(name),
    u16(type),
    u16(1),
    answers,
  ]);
}

// ---------- capture files ----------

function pcapFile(frames) {
  const header = Buffer.concat([
    Buffer.from([0xd4, 0xc3, 0xb2, 0xa1]), // little-endian, microseconds
    Buffer.from([2, 0, 4, 0]),
    u32le(0),
    u32le(0),
    u32le(65535),
    u32le(1), // Ethernet
  ]);
  const records = frames.map(({ t, data }) => {
    const sec = Math.floor(t);
    const usec = Math.round((t - sec) * 1e6);
    return Buffer.concat([u32le(sec), u32le(usec), u32le(data.length), u32le(data.length), data]);
  });
  return Buffer.concat([header, ...records]);
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

const pad4 = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

function ngBlock(type, body) {
  const padded = pad4(body);
  const total = padded.length + 12;
  return Buffer.concat([u32le(type), u32le(total), padded, u32le(total)]);
}

function ngOption(code, value) {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(code, 0);
  head.writeUInt16LE(value.length, 2);
  return pad4(Buffer.concat([head, value]));
}

const ngEnd = Buffer.alloc(4);

function pcapngFile(interfaces, packets) {
  const shb = ngBlock(
    0x0a0d0d0a,
    Buffer.concat([
      u32le(0x1a2b3c4d),
      Buffer.from([1, 0, 0, 0]),
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // section length unknown
      ngOption(4, ascii('find-the-flag sample generator')),
      ngEnd,
    ]),
  );
  const idbs = interfaces.map((i) => {
    const head = Buffer.alloc(8);
    head.writeUInt16LE(i.link, 0);
    head.writeUInt32LE(0, 4); // no snap length limit
    return ngBlock(
      1,
      Buffer.concat([head, ngOption(2, ascii(i.name)), ngOption(9, Buffer.from([6])), ngEnd]),
    );
  });
  const epbs = packets.map(({ iface, t, data }) => {
    const ticks = Math.round(t * 1e6);
    const head = Buffer.alloc(20);
    head.writeUInt32LE(iface, 0);
    head.writeUInt32LE(Math.floor(ticks / 4294967296), 4);
    head.writeUInt32LE(ticks % 4294967296, 8);
    head.writeUInt32LE(data.length, 12);
    head.writeUInt32LE(data.length, 16);
    return ngBlock(6, Buffer.concat([head, data]));
  });
  return Buffer.concat([shb, ...idbs, ...epbs]);
}

// ---------- scenario 1: HTTP + FTP + DNS ----------

const CLIENT = { mac: '02:00:00:00:00:0a', ip: '192.168.1.10' };
const GATEWAY = { mac: '02:00:00:00:00:01', ip: '192.168.1.1' };
const WEB = { mac: '02:00:00:00:00:14', ip: '192.168.1.20' };
const FTP = { mac: '02:00:00:00:00:1e', ip: '192.168.1.30' };

function scenarioHttp() {
  const frames = [];
  let clock = 1700000000.0;
  const emit = (from, to, ipPacket) => {
    clock += 0.0004 + (frames.length % 5) * 0.0003;
    frames.push({ t: clock, data: ethernet(from.mac, to.mac, 0x0800, ipPacket) });
  };
  const raw = (from, to, type, payload) => {
    clock += 0.0004;
    frames.push({ t: clock, data: ethernet(from.mac, to.mac, type, payload) });
  };

  /** A TCP connection; every method appends frames and keeps both sequence numbers. */
  function connection(client, server, cport, sport, isnC, isnS) {
    let seqC = isnC;
    let seqS = isnS;
    const toS = (flags, payload = Buffer.alloc(0), seqOverride) =>
      emit(
        client,
        server,
        tcp(client.ip, server.ip, cport, sport, seqOverride ?? seqC, seqS, flags, payload),
      );
    const toC = (flags, payload = Buffer.alloc(0), seqOverride) =>
      emit(
        server,
        client,
        tcp(server.ip, client.ip, sport, cport, seqOverride ?? seqS, seqC, flags, payload),
      );
    return {
      handshake() {
        toS(0x02);
        seqC++;
        toC(0x12);
        seqS++;
        toS(0x10);
      },
      client(text) {
        const data = ascii(text);
        toS(0x18, data);
        seqC += data.length;
        toC(0x10);
      },
      /** Server sends `parts` as separate segments; `repeat` retransmits that segment index. */
      server(parts, repeat = -1) {
        parts.forEach((text, i) => {
          const data = ascii(text);
          const start = seqS;
          toC(0x18, data);
          seqS += data.length;
          if (i === repeat) toC(0x18, data, start);
          toS(0x10);
        });
      },
      close() {
        toC(0x11);
        seqS++;
        toS(0x11);
        seqC++;
        toC(0x10);
      },
    };
  }

  // The gateway tells the client where it is.
  raw(
    CLIENT,
    { mac: 'ff:ff:ff:ff:ff:ff' },
    0x0806,
    arp(1, CLIENT.mac, CLIENT.ip, '00:00:00:00:00:00', GATEWAY.ip),
  );
  raw(GATEWAY, CLIENT, 0x0806, arp(2, GATEWAY.mac, GATEWAY.ip, CLIENT.mac, CLIENT.ip));

  const dns = (id, port, name, type, answer) => {
    emit(CLIENT, GATEWAY, udp(CLIENT.ip, GATEWAY.ip, port, 53, dnsQuery(id, name, type)));
    emit(GATEWAY, CLIENT, udp(GATEWAY.ip, CLIENT.ip, 53, port, dnsAnswer(id, name, type, answer)));
  };
  dns(0x1a2b, 53211, 'ctf.example.org', 1, WEB.ip);
  dns(0x1a2c, 53212, 'ctf.example.org', 28, null);

  // Stream 0: HTTP download. The flag is cut in two segments and the first one is retransmitted.
  const body = 'Congratulations, you reassembled the stream.\nflag{follow_the_stream}\n';
  const headers =
    'HTTP/1.1 200 OK\r\nServer: ctf-httpd/1.0\r\nContent-Type: text/plain\r\n' +
    `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  const cut = body.indexOf('follow_') + 7;
  const http = connection(CLIENT, WEB, 49152, 80, 1000000, 5000000);
  http.handshake();
  http.client(
    'GET /secret.txt HTTP/1.1\r\nHost: ctf.example.org\r\nUser-Agent: curl/8.0\r\nAccept: */*\r\n\r\n',
  );
  http.server([headers + body.slice(0, cut), body.slice(cut)], 0);
  http.close();

  dns(0x1a2d, 53213, 'ftp.example.org', 1, FTP.ip);

  // Stream 1: FTP control connection (cleartext login), stream 2: passive data connection.
  const ctl = connection(CLIENT, FTP, 49160, 21, 2000000, 7000000);
  ctl.handshake();
  ctl.server(['220 ctf-ftpd ready\r\n']);
  ctl.client('USER ctf\r\n');
  ctl.server(['331 Password required for ctf\r\n']);
  ctl.client('PASS hunter2\r\n');
  ctl.server(['230 User ctf logged in\r\n']);
  ctl.client('PASV\r\n');
  ctl.server(['227 Entering Passive Mode (192,168,1,30,195,80)\r\n']); // port 50000
  ctl.client('RETR notes.txt\r\n');
  ctl.server(['150 Opening BINARY mode data connection for notes.txt\r\n']);
  const data = connection(CLIENT, FTP, 41000, 50000, 3000000, 9000000);
  data.handshake();
  data.server([
    'Nothing to see in this file.\nThe flag is not here, keep following the streams.\n',
  ]);
  data.close();
  ctl.server(['226 Transfer complete\r\n']);
  ctl.client('QUIT\r\n');
  ctl.server(['221 Goodbye\r\n']);
  ctl.close();

  return frames;
}

// ---------- scenario 2: ICMP exfiltration (pcapng, two interfaces) ----------

function scenarioExfil() {
  const packets = [];
  let clock = 1700001000.0;
  const evil = { mac: '02:00:00:00:00:63', ip: '192.168.1.99' };
  const secret = 'flag{icmp_exfil}';
  const add = (iface, data) => {
    clock += 0.25;
    packets.push({ iface, t: clock, data });
  };
  // Interface 1 is the loopback: ordinary pings with the Linux padding pattern.
  const padding = Buffer.from(Array.from({ length: 40 }, (_, i) => 0x10 + i));
  const nullFrame = (ipPacket) => Buffer.concat([Buffer.from([2, 0, 0, 0]), ipPacket]);
  add(
    1,
    nullFrame(
      icmpEcho(
        '127.0.0.1',
        '127.0.0.1',
        false,
        0x0042,
        1,
        Buffer.concat([Buffer.alloc(8), padding]),
      ),
    ),
  );
  add(
    1,
    nullFrame(
      icmpEcho(
        '127.0.0.1',
        '127.0.0.1',
        true,
        0x0042,
        1,
        Buffer.concat([Buffer.alloc(8), padding]),
      ),
    ),
  );
  // Interface 0: 4 bytes of the secret per echo request, answered by an echo reply.
  for (let i = 0; i * 4 < secret.length; i++) {
    const chunk = ascii(secret.slice(i * 4, i * 4 + 4));
    add(
      0,
      ethernet(
        CLIENT.mac,
        evil.mac,
        0x0800,
        icmpEcho(CLIENT.ip, evil.ip, false, 0x1337, i + 1, chunk),
      ),
    );
    add(
      0,
      ethernet(
        evil.mac,
        CLIENT.mac,
        0x0800,
        icmpEcho(evil.ip, CLIENT.ip, true, 0x1337, i + 1, chunk),
      ),
    );
  }
  add(
    1,
    nullFrame(
      icmpEcho(
        '127.0.0.1',
        '127.0.0.1',
        false,
        0x0042,
        2,
        Buffer.concat([Buffer.alloc(8), padding]),
      ),
    ),
  );
  return packets;
}

const out = (name) => new URL(`../public/samples/${name}`, import.meta.url);

writeFileSync(out('forensics-http.pcap'), pcapFile(scenarioHttp()));
writeFileSync(
  out('forensics-exfil.pcapng'),
  pcapngFile(
    [
      { link: 1, name: 'eth0' },
      { link: 0, name: 'lo' },
    ],
    scenarioExfil(),
  ),
);
console.log('wrote public/samples/forensics-http.pcap and forensics-exfil.pcapng');
