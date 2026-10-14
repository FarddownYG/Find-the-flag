import { readFileSync } from 'node:fs';
import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../core/errors';
import { resultToText } from '../../core/result-text';
import type { Output } from '../../core/types';
import { concatBytes, latin1Decode, latin1Encode, toHex } from '../../lib/bytes';
import { analyze } from './_pcap-analyze';
import { exportObjects } from './_pcap-extract';
import tool from './pcap';

// ---------- helpers: build captures by hand ----------

const sample = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../public/samples/${name}`, import.meta.url)));

type Opts = Parameters<typeof tool.run>[1];
const defaults: Opts = {
  mode: 'overview',
  filter: '',
  stream: -1,
  limit: 5,
  view: 'ascii',
  domainLabels: 2,
  sortSeq: false,
};
const run = (bytes: Uint8Array, o: Partial<Opts> = {}): Output[] =>
  tool.run({ bytes }, { ...defaults, ...o }) as Output[];
const text = (bytes: Uint8Array, o: Partial<Opts> = {}) => resultToText(run(bytes, o));

const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >> 8) & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const ipv4 = (s: string) => s.split('.').map(Number);
const bytes = (...parts: (number[] | Uint8Array)[]) =>
  concatBytes(...parts.map((p) => Uint8Array.from(p)));

function ipPacket(
  src: string,
  dst: string,
  proto: number,
  body: Uint8Array,
  extra = {},
): Uint8Array {
  const o = { id: 1, fragOff: 0, more: false, ...extra };
  const flagsFrag = (o.more ? 0x2000 : 0) | (o.fragOff >> 3);
  return bytes(
    [0x45, 0, ...be16(20 + body.length), ...be16(o.id), ...be16(flagsFrag), 64, proto, 0, 0],
    ipv4(src),
    ipv4(dst),
    body,
  );
}

const eth = (payload: Uint8Array, type = 0x0800) =>
  bytes([2, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 1, ...be16(type)], payload);

interface Seg {
  from: 'c' | 's';
  seq: number;
  flags: number;
  data?: string | Uint8Array;
}
const C = { ip: '10.0.0.1', port: 40000 };
const S = { ip: '10.0.0.2', port: 80 };

function tcpFrame(seg: Seg, c = C, s = S): Uint8Array {
  const [a, b] = seg.from === 'c' ? [c, s] : [s, c];
  const data =
    typeof seg.data === 'string' ? latin1Encode(seg.data) : (seg.data ?? new Uint8Array());
  const tcp = bytes(
    [
      ...be16(a.port),
      ...be16(b.port),
      ...be32(seg.seq),
      ...be32(0),
      0x50,
      seg.flags,
      ...be16(1000),
      0,
      0,
      0,
      0,
    ],
    data,
  );
  return eth(ipPacket(a.ip, b.ip, 6, tcp));
}

const udpFrame = (src: string, dst: string, sport: number, dport: number, data: Uint8Array) =>
  eth(
    ipPacket(
      src,
      dst,
      17,
      bytes([...be16(sport), ...be16(dport), ...be16(8 + data.length), 0, 0], data),
    ),
  );

const icmpFrame = (
  src: string,
  dst: string,
  type: number,
  id: number,
  seq: number,
  data: Uint8Array,
) => eth(ipPacket(src, dst, 1, bytes([type, 0, 0, 0, ...be16(id), ...be16(seq)], data)));

interface Rec {
  t: number;
  data: Uint8Array;
}

interface PcapOpts {
  big?: boolean;
  nano?: boolean;
  link?: number;
}

function pcap(recs: Rec[], o: PcapOpts = {}): Uint8Array {
  const w32 = o.big ? be32 : le32;
  const w16 = o.big ? be16 : le16;
  const magic = o.nano ? 0xa1b23c4d : 0xa1b2c3d4;
  const out: number[][] = [
    [...w32(magic), ...w16(2), ...w16(4), ...w32(0), ...w32(0), ...w32(65535), ...w32(o.link ?? 1)],
  ];
  const parts: Uint8Array[] = [Uint8Array.from(out[0]!)];
  for (const r of recs) {
    const sec = Math.floor(r.t);
    const frac = Math.round((r.t - sec) * (o.nano ? 1e9 : 1e6));
    parts.push(
      Uint8Array.from([...w32(sec), ...w32(frac), ...w32(r.data.length), ...w32(r.data.length)]),
      r.data,
    );
  }
  return concatBytes(...parts);
}

const timed = (frames: Uint8Array[], t0 = 1_700_000_000): Rec[] =>
  frames.map((data, i) => ({ t: t0 + i * 0.001, data }));

/** SYN handshake followed by the given segments; sequence numbers are filled in by the caller. */
const handshake = (): Seg[] => [
  { from: 'c', seq: 100, flags: 0x02 },
  { from: 's', seq: 900, flags: 0x12 },
  { from: 'c', seq: 101, flags: 0x10 },
];

/** A whole text conversation: each message is sent as one in-order segment. */
function conversation(msgs: ['c' | 's', string][], c = C, s = S): Uint8Array[] {
  const seqs = { c: 101, s: 901 };
  const segs: Seg[] = handshake();
  for (const [from, data] of msgs) {
    segs.push({ from, seq: seqs[from], flags: 0x18, data });
    seqs[from] += data.length;
  }
  return segs.map((seg) => tcpFrame(seg, c, s));
}

const tableOf = (out: Output[], label: string) => {
  const t = out.find((o) => o.type === 'table' && o.label?.startsWith(label));
  if (!t || t.type !== 'table') throw new Error(`no table "${label}"`);
  return t;
};

// ---------- the generated samples ----------

describe('pcap samples', () => {
  it('overview of the HTTP sample finds the flag split across segments', () => {
    const out = run(sample('forensics-http.pcap'));
    const flags = tableOf(out, 'Flag-like strings');
    expect(flags.rows.map((r) => r[0])).toEqual(['flag{follow_the_stream}']);
    const creds = tableOf(out, 'Credentials');
    expect(creds.rows[0]).toEqual(['FTP', '192.168.1.30:21', 'ctf', 'hunter2', 1]);
    const dns = tableOf(out, 'DNS queries');
    expect(dns.rows.map((r) => [r[1], r[2], r[4]])).toEqual([
      ['ctf.example.org', 'A', 'A 192.168.1.20'],
      ['ctf.example.org', 'AAAA', 'No such name'],
      ['ftp.example.org', 'A', 'A 192.168.1.30'],
    ]);
    const http = tableOf(out, 'HTTP requests');
    expect(http.rows[0]).toEqual([
      0,
      'GET',
      'ctf.example.org',
      '/secret.txt',
      200,
      'text/plain',
      69,
    ]);
    const protos = Object.fromEntries(tableOf(out, 'Protocols').rows.map((r) => [r[0], r[1]]));
    expect(protos).toMatchObject({ ARP: 2, DNS: 6, HTTP: 4, 'FTP-DATA': 1 });
  });

  it('follows one stream and notes the retransmission', () => {
    const out = run(sample('forensics-http.pcap'), { mode: 'streams', stream: 0 });
    const t = resultToText(out);
    expect(t).toContain('GET /secret.txt HTTP/1.1');
    expect(t).toContain('flag{follow_the_stream}');
    expect(tableOf(out, 'Streams').rows[0]![6]).toBe('1 retransmitted');
  });

  it('lists the first streams with their conversation, in hex too', () => {
    const t = text(sample('forensics-http.pcap'), { mode: 'streams' });
    expect(t).toContain('USER ctf');
    expect(t).toContain('PASS hunter2');
    const hex = text(sample('forensics-http.pcap'), { mode: 'streams', stream: 0, view: 'hex' });
    expect(hex).toContain('47 45 54 20 2f 73 65 63'); // "GET /sec"
  });

  it('filters streams by content', () => {
    const out = run(sample('forensics-http.pcap'), { mode: 'streams', filter: 'hunter2' });
    expect(tableOf(out, 'Streams').rows.map((r) => r[0])).toEqual([1]);
  });

  it('rejects a stream number that does not exist', () => {
    expect(() => run(sample('forensics-http.pcap'), { mode: 'streams', stream: 99 })).toThrow(
      ToolError,
    );
  });

  it('exports the HTTP body and the FTP-DATA file', () => {
    const files = exportObjects(analyze(sample('forensics-http.pcap')));
    expect(files.map((f) => f.name)).toEqual(['secret.txt', 'notes.txt']);
    expect(latin1Decode(files[0]!.data)).toContain('flag{follow_the_stream}');
    expect(latin1Decode(files[1]!.data)).toContain('Nothing to see');
    const out = run(sample('forensics-http.pcap'), { mode: 'export' });
    expect(out.find((o) => o.type === 'files')).toBeDefined();
  });

  it('packet list looks like Wireshark', () => {
    const out = run(sample('forensics-http.pcap'), { mode: 'packets', filter: 'secret.txt' });
    const t = tableOf(out, 'Packets');
    expect(t.columns).toEqual([
      'No.',
      'Time',
      'Source',
      'Destination',
      'Protocol',
      'Length',
      'Info',
    ]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]!.slice(2, 5)).toEqual(['192.168.1.10', '192.168.1.20', 'HTTP']);
    expect(t.rows[0]![6]).toBe('GET /secret.txt HTTP/1.1');
    const arp = text(sample('forensics-http.pcap'), { mode: 'packets', filter: 'arp' });
    expect(arp).toContain('Who has 192.168.1.1? Tell 192.168.1.10');
  });

  it('rebuilds the ICMP exfiltration of the pcapng sample, loopback padding last', () => {
    const out = run(sample('forensics-exfil.pcapng'), { mode: 'exfil' });
    const blocks = out.filter((o) => o.type === 'text');
    expect(blocks[0]).toMatchObject({ type: 'text', value: 'flag{icmp_exfil}' });
    expect(resultToText(out)).toContain('ordinary ping padding');
    const overview = tableOf(run(sample('forensics-exfil.pcapng')), 'Flag-like strings');
    expect(overview.rows[0]![0]).toBe('flag{icmp_exfil}');
  });

  it('reads the pcapng interfaces and link types', () => {
    const a = analyze(sample('forensics-exfil.pcapng'));
    expect(a.cap.linkTypes).toEqual([1, 0]);
    expect(a.cap.packets).toHaveLength(11);
    expect(a.cap.packets[0]!.link).toBe(0);
  });

  it('is detected by its magic bytes', () => {
    expect(
      tool.detect?.({ text: null, bytes: sample('forensics-http.pcap') })?.score,
    ).toBeGreaterThan(0.9);
    expect(
      tool.detect?.({ text: null, bytes: sample('forensics-exfil.pcapng') })?.score,
    ).toBeGreaterThan(0.9);
    expect(tool.detect?.({ text: 'hello world', bytes: latin1Encode('hello world') })).toBeNull();
  });
});

// ---------- TCP reassembly ----------

describe('pcap TCP reassembly', () => {
  const serverBytes = (frames: Uint8Array[]) => {
    const a = analyze(pcap(timed(frames)));
    return { a, s: a.streams[0]!, text: latin1Decode(a.streams[0]!.s2c) };
  };

  it('orders out-of-order segments and drops retransmissions', () => {
    const hello = 'Hello, ';
    const frames = [
      ...handshake(),
      { from: 's', seq: 901 + 10, flags: 0x18, data: 'ld!' } as Seg, // third piece first
      { from: 's', seq: 901, flags: 0x18, data: hello } as Seg,
      { from: 's', seq: 901, flags: 0x18, data: hello } as Seg, // retransmission
      { from: 's', seq: 901 + 7, flags: 0x18, data: 'wor' } as Seg,
      { from: 's', seq: 901 + 10, flags: 0x18, data: 'ld!' } as Seg, // retransmission
    ].map((seg) => tcpFrame(seg));
    const { s, text: t } = serverBytes(frames);
    expect(t).toBe('Hello, world!');
    expect(s.retransmits).toBe(2);
    expect(s.outOfOrder).toBeGreaterThan(0);
    expect(s.missingBytes).toBe(0);
  });

  it('trims overlapping segments and keeps the first copy', () => {
    const frames = [
      ...handshake(),
      { from: 's', seq: 901, flags: 0x18, data: 'abcdef' } as Seg,
      { from: 's', seq: 904, flags: 0x18, data: 'DEFghi' } as Seg, // overlaps "def"
    ].map((seg) => tcpFrame(seg));
    expect(serverBytes(frames).text).toBe('abcdefghi');
  });

  it('survives sequence number wraparound', () => {
    const isn = 0xfffffffa;
    const frames = [
      { from: 'c', seq: 1, flags: 0x02 },
      { from: 's', seq: isn - 1, flags: 0x12 },
      { from: 'c', seq: 2, flags: 0x10 },
      { from: 's', seq: isn + 9, flags: 0x18, data: 'WORLD' }, // wraps past 2^32
      { from: 's', seq: isn, flags: 0x18, data: 'HELLO ' },
      { from: 's', seq: (isn + 6) >>> 0, flags: 0x18, data: 'to ' }, // ends just before the wrap
    ].map((seg) => tcpFrame(seg as Seg));
    expect(serverBytes(frames).text).toBe('HELLO to WORLD');
  });

  it('reports a gap when a segment was never captured', () => {
    const frames = [
      ...handshake(),
      { from: 's', seq: 901, flags: 0x18, data: 'start-' } as Seg,
      { from: 's', seq: 901 + 20, flags: 0x18, data: '-end' } as Seg,
    ].map((seg) => tcpFrame(seg));
    const { s } = serverBytes(frames);
    expect(s.missingBytes).toBe(14);
    expect(s.blocks.map((b) => b.gapBefore)).toEqual([0, 14]);
    expect(text(pcap(timed(frames)), { mode: 'streams', stream: 0 })).toContain('14 bytes missing');
  });

  it('starts a new stream when a SYN reuses the ports of a finished connection', () => {
    const second = [
      { from: 'c', seq: 5000, flags: 0x02 },
      { from: 's', seq: 8000, flags: 0x12 },
      { from: 'c', seq: 5001, flags: 0x10 },
      { from: 'c', seq: 5001, flags: 0x18, data: 'second' },
    ] as Seg[];
    const frames = [
      ...handshake(),
      { from: 'c', seq: 101, flags: 0x18, data: 'first' } as Seg,
      { from: 'c', seq: 106, flags: 0x04 } as Seg,
      ...second,
    ].map((seg) => tcpFrame(seg));
    const a = analyze(pcap(timed(frames)));
    expect(a.streams.map((s) => latin1Decode(s.c2s))).toEqual(['first', 'second']);
  });

  it('interleaves both directions by when the data became available', () => {
    const frames = conversation([
      ['c', 'ping\n'],
      ['s', 'pong\n'],
      ['c', 'bye\n'],
    ]);
    const { s } = serverBytes(frames);
    expect(s.blocks.map((b) => [b.dir, latin1Decode(b.data)])).toEqual([
      [0, 'ping\n'],
      [1, 'pong\n'],
      [0, 'bye\n'],
    ]);
  });
});

// ---------- HTTP ----------

describe('pcap HTTP', () => {
  const http = (
    response: Uint8Array,
    request = 'GET /data.bin HTTP/1.1\r\nHost: h.example\r\n\r\n',
  ) => {
    const segs: Seg[] = [
      ...handshake(),
      { from: 'c', seq: 101, flags: 0x18, data: request },
      { from: 's', seq: 901, flags: 0x18, data: response },
    ];
    return pcap(timed(segs.map((s) => tcpFrame(s))));
  };

  it('decodes chunked bodies split over several chunks and segments', () => {
    const response = latin1Encode(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n' +
        '6\r\nflag{c\r\n8\r\nhunked_o\r\n4\r\nk}\n\n\r\n0\r\n\r\n',
    );
    const files = exportObjects(analyze(http(response)));
    expect(latin1Decode(files[0]!.data)).toBe('flag{chunked_ok}\n\n');
    expect(files[0]!.name).toBe('data.bin');
    // chunk boundaries split the flag: only the decoded body finds it
    const flags = tableOf(run(http(response)), 'Flag-like strings');
    expect(flags.rows[0]![0]).toBe('flag{chunked_ok}');
  });

  it('gunzips Content-Encoding: gzip bodies', () => {
    const plain = latin1Encode('flag{gzip_inside}\n'.repeat(20));
    const body = gzipSync(plain);
    const head = latin1Encode(
      `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\n\r\n`,
    );
    const capture = http(concatBytes(head, body), 'GET /page HTTP/1.1\r\nHost: h\r\n\r\n');
    const files = exportObjects(analyze(capture));
    expect(files[0]!.name).toBe('page.html');
    expect(toHex(files[0]!.data)).toBe(toHex(plain));
    expect(files[0]!.note).toContain('gunzipped');
    expect(tableOf(run(capture), 'Flag-like strings').rows[0]![0]).toBe('flag{gzip_inside}');
  });

  it('handles pipelined requests, HEAD responses and a cut-off body', () => {
    const req =
      'GET /a HTTP/1.1\r\nHost: h\r\n\r\nHEAD /b HTTP/1.1\r\nHost: h\r\n\r\nGET /c HTTP/1.1\r\nHost: h\r\n\r\n';
    const resp =
      'HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc' +
      'HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n' + // answer to HEAD: no body follows
      'HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort';
    const a = analyze(http(latin1Encode(resp), req));
    const ex = a.http();
    expect(ex.map((x) => x.request?.uri)).toEqual(['/a', '/b', '/c']);
    expect(ex.map((x) => latin1Decode(x.response!.body))).toEqual(['abc', '', 'short']);
    expect(ex[2]!.response!.notes).toContain('body cut off');
  });

  it('finds Basic auth, form logins and URL-encoded flags', () => {
    const form = 'username=bob&password=p%40ss+w0rd';
    const req =
      'POST /login?next=%2F HTTP/1.1\r\nHost: h\r\nAuthorization: Basic YWRtaW46czNjcjN0\r\n' +
      `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${form.length}\r\n\r\n${form}`;
    const found = http(latin1Encode('HTTP/1.1 302 Found\r\nLocation: /\r\n\r\n'), req);
    const rows = tableOf(run(found), 'Credentials').rows.map((r) => [r[0], r[2], r[3]]);
    expect(rows).toContainEqual(['HTTP Basic', 'admin', 's3cr3t']);
    expect(rows).toContainEqual(['HTTP form', 'bob', 'p@ss w0rd']);
    const exfil = http(
      latin1Encode('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'),
      'GET /x?d=flag%7Burl_decoded%7D HTTP/1.1\r\nHost: h\r\n\r\n',
    );
    expect(tableOf(run(exfil), 'Flag-like strings').rows[0]![0]).toBe('flag{url_decoded}');
  });

  it('exports multipart uploads by file name', () => {
    const body =
      '--XX\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n' +
      '--XX\r\nContent-Disposition: form-data; name="f"; filename="loot.txt"\r\nContent-Type: text/plain\r\n\r\nsecret data\r\n--XX--\r\n';
    const req = `POST /up HTTP/1.1\r\nHost: h\r\nContent-Type: multipart/form-data; boundary=XX\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
    const files = exportObjects(
      analyze(http(latin1Encode('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'), req)),
    );
    expect(files.map((f) => f.name)).toEqual(['loot.txt']);
    expect(latin1Decode(files[0]!.data)).toBe('secret data');
  });
});

// ---------- other protocols ----------

describe('pcap cleartext protocols', () => {
  const creds = (frames: Uint8Array[]) =>
    analyze(pcap(timed(frames)))
      .credentials()
      .map((x) => [x.proto, x.user, x.secret]);
  const b64 = (s: string) => btoa(s);

  it('Telnet login typed one key per packet with echo', () => {
    const msgs: ['c' | 's', string][] = [['s', '\xff\xfd\x18Welcome\r\nlogin: ']];
    for (const ch of 'root\r') msgs.push(['c', ch], ['s', ch === '\r' ? '\r\nPassword: ' : ch]);
    for (const ch of 'toor1\r') msgs.push(['c', ch]); // password is not echoed
    msgs.push(['s', '\r\nLast login: never\r\n$ ']);
    expect(creds(conversation(msgs, C, { ip: S.ip, port: 23 }))).toEqual([
      ['Telnet', 'root', 'toor1'],
    ]);
  });

  it('Telnet user called "user" is not mistaken for a prompt', () => {
    const msgs: ['c' | 's', string][] = [['s', 'login: ']];
    for (const ch of 'user\r') msgs.push(['c', ch], ['s', ch === '\r' ? '\r\nPassword: ' : ch]);
    for (const ch of 'pw\r') msgs.push(['c', ch]);
    expect(creds(conversation(msgs, C, { ip: S.ip, port: 23 }))).toEqual([
      ['Telnet', 'user', 'pw'],
    ]);
  });

  it('SMTP AUTH LOGIN and AUTH PLAIN', () => {
    const login = conversation(
      [
        ['s', '220 mail ESMTP\r\n'],
        ['c', 'EHLO me\r\n'],
        ['s', '250-mail\r\n250 AUTH LOGIN PLAIN\r\n'],
        ['c', 'AUTH LOGIN\r\n'],
        ['s', `334 ${b64('Username:')}\r\n`],
        ['c', `${b64('alice')}\r\n`],
        ['s', `334 ${b64('Password:')}\r\n`],
        ['c', `${b64('wonder')}\r\n`],
        ['s', '235 ok\r\n'],
      ],
      C,
      { ip: S.ip, port: 25 },
    );
    expect(creds(login)).toEqual([['SMTP', 'alice', 'wonder']]);
    const plain = conversation(
      [
        ['s', '220 mail ESMTP\r\n'],
        ['c', 'EHLO me\r\n'],
        ['c', `AUTH PLAIN ${b64('\0carol\0pa55')}\r\n`],
      ],
      C,
      { ip: S.ip, port: 25 },
    );
    expect(creds(plain)).toEqual([['SMTP', 'carol', 'pa55']]);
  });

  it('POP3 and IMAP logins', () => {
    const pop = conversation(
      [
        ['s', '+OK ready\r\n'],
        ['c', 'USER dave\r\n'],
        ['s', '+OK\r\n'],
        ['c', 'PASS letmein\r\n'],
      ],
      C,
      { ip: S.ip, port: 110 },
    );
    expect(creds(pop)).toEqual([['POP3', 'dave', 'letmein']]);
    const imap = conversation(
      [
        ['s', '* OK IMAP ready\r\n'],
        ['c', 'a1 LOGIN "erin" "p w"\r\n'],
      ],
      C,
      { ip: S.ip, port: 143 },
    );
    expect(creds(imap)).toEqual([['IMAP', 'erin', 'p w']]);
  });

  it('reads the server name of a TLS ClientHello', () => {
    const name = 'secret.ctf.example';
    const sni = [...be16(name.length + 3), 0, ...be16(name.length), ...latin1Encode(name)];
    const ext = [...be16(0), ...be16(sni.length), ...sni];
    const hello = [
      3,
      3,
      ...new Array(32).fill(7),
      0, // session id
      ...be16(2),
      0x13,
      0x01, // cipher suites
      1,
      0, // compression
      ...be16(ext.length),
      ...ext,
    ];
    const handshake_ = [1, 0, ...be16(hello.length), ...hello];
    const record = Uint8Array.from([0x16, 3, 1, ...be16(handshake_.length), ...handshake_]);
    const frames = conversation([['c', latin1Decode(record)]], C, { ip: S.ip, port: 443 });
    const a = analyze(pcap(timed(frames)));
    expect(a.sni()[0]?.name).toBe(name);
    expect(text(pcap(timed(frames)), { mode: 'packets' })).toContain(`Client Hello (SNI=${name})`);
    expect(tableOf(run(pcap(timed(frames))), 'TLS server names').rows[0]![3]).toBe(name);
  });
});

describe('pcap other transfers', () => {
  it('exports an active-mode FTP upload (PORT + STOR) by its file name', () => {
    const ftp = { ip: '10.0.0.2', port: 21 };
    const control = conversation(
      [
        ['s', '220 ready\r\n'],
        ['c', 'USER anon\r\n'],
        ['c', 'PORT 10,0,0,1,156,64\r\n'], // 156*256+64 = 40000
        ['c', 'STOR up/loot.bin\r\n'],
      ],
      C,
      ftp,
    );
    // active mode: the FTP server (port 20) connects back to the client's data port
    const data = conversation(
      [['s', 'uploaded bytes: flag{from_ftp_data}']],
      { ip: '10.0.0.2', port: 20 },
      { ip: '10.0.0.1', port: 40000 },
    );
    const files = exportObjects(analyze(pcap(timed([...control, ...data]))));
    expect(files.map((f) => f.name)).toEqual(['loot.bin']);
    expect(latin1Decode(files[0]!.data)).toContain('flag{from_ftp_data}');
    expect(files[0]!.note).toContain('upload');
  });

  it('exports a raw TCP stream that starts with a file signature (nc file transfer)', () => {
    const png = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) + 'IHDR...';
    const frames = conversation([['s', png]], C, { ip: S.ip, port: 4444 });
    const files = exportObjects(analyze(pcap(timed(frames))));
    expect(files.map((f) => f.name)).toEqual(['stream-0.png']);
  });

  it('follows a UDP flow', () => {
    const frames = [
      udpFrame('10.0.0.1', '10.0.0.2', 40000, 9999, latin1Encode('knock knock')),
      udpFrame('10.0.0.1', '10.0.0.2', 40000, 9999, latin1Encode(' again')),
      udpFrame('10.0.0.2', '10.0.0.1', 9999, 40000, latin1Encode('flag{udp_flow}')),
    ];
    const out = run(pcap(timed(frames)), { mode: 'streams' });
    const row = tableOf(out, 'Streams').rows[0]!;
    expect(row.slice(1, 5)).toEqual(['UDP', '10.0.0.1:40000', '10.0.0.2:9999', 3]);
    const t = resultToText(out);
    expect(t).toContain('knock knock again');
    expect(t).toContain('flag{udp_flow}');
  });
});

// ---------- DNS and ICMP exfiltration ----------

describe('pcap exfiltration', () => {
  const dnsQuery = (id: number, name: string) =>
    bytes(
      [...be16(id), 1, 0, 0, 1, 0, 0, 0, 0, 0, 0],
      ...name.split('.').map((l) => bytes([l.length], latin1Encode(l))),
      [0, 0, 1, 0, 1],
    );

  it('joins DNS subdomain labels and decodes the hex', () => {
    const secret = 'flag{dns_labels}';
    const hex = toHex(latin1Encode(secret));
    const frames: Uint8Array[] = [];
    hex.match(/.{1,8}/g)!.forEach((chunk, i) => {
      // two data labels per query: "<hex>.<hex>.tunnel.example"
      const name = `${chunk.slice(0, 4)}.${chunk.slice(4)}.tunnel.example`;
      frames.push(udpFrame('10.0.0.1', '10.0.0.53', 5000 + i, 53, dnsQuery(i, name)));
      frames.push(udpFrame('10.0.0.1', '10.0.0.53', 5000 + i, 53, dnsQuery(i + 100, name))); // A + AAAA
    });
    frames.push(udpFrame('10.0.0.1', '10.0.0.53', 6000, 53, dnsQuery(999, 'www.google.com')));
    const file = pcap(timed(frames));
    const out = run(file, { mode: 'exfil' });
    const blocks = out.filter((o) => o.type === 'text');
    expect(blocks.map((b) => b.type === 'text' && b.value)).toEqual([hex, secret]);
    expect(resultToText(out)).toContain('decoded from hex');
    // the overview finds the flag in the decoded form
    expect(tableOf(run(file), 'Flag-like strings').rows[0]![0]).toBe(secret);
    // keeping one more label as "domain" cuts the data down
    expect(resultToText(run(file, { mode: 'exfil', domainLabels: 3 }))).not.toContain(secret);
  });

  it('keeps ICMP chunks in capture order, or by sequence number on request', () => {
    const chunks = ['flag{ord', 'er_by_s', 'eq}'];
    const order = [1, 0, 2]; // captured out of order
    const frames = order.map((i) =>
      icmpFrame('10.0.0.1', '10.0.0.9', 8, 7, i + 1, latin1Encode(chunks[i]!)),
    );
    // an echo reply must not be doubled into the data
    frames.push(icmpFrame('10.0.0.9', '10.0.0.1', 0, 7, 1, latin1Encode(chunks[0]!)));
    const file = pcap(timed(frames));
    expect(text(file, { mode: 'exfil' })).toContain('er_by_sflag{ord' + 'eq}');
    expect(text(file, { mode: 'exfil', sortSeq: true })).toContain('flag{order_by_seq}');
  });
});

// ---------- containers and link layers ----------

describe('pcap file formats', () => {
  const dns = udpFrame(
    '10.0.0.1',
    '10.0.0.2',
    1234,
    53,
    Uint8Array.from([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 97, 0, 0, 1, 0, 1]),
  );

  it.each([
    ['little-endian microseconds', {}],
    ['big-endian microseconds', { big: true }],
    ['little-endian nanoseconds', { nano: true }],
    ['big-endian nanoseconds', { big: true, nano: true }],
  ] as [string, PcapOpts][])('libpcap %s', (_name, o) => {
    const a = analyze(
      pcap(
        [
          { t: 1_700_000_000.25, data: dns },
          { t: 1_700_000_001.5, data: dns },
        ],
        o,
      ),
    );
    expect(a.cap.packets).toHaveLength(2);
    expect(a.pkts[0]!.proto).toBe('DNS');
    expect(a.lastTime - a.firstTime).toBeCloseTo(1.25, 5);
    expect(a.cap.format).toContain(o.nano ? 'nanosecond' : 'microsecond');
    expect(a.cap.format).toContain(o.big ? 'big' : 'little');
  });

  it('reads pcapng with several interfaces, timestamp resolutions and a simple packet block', () => {
    const w32 = le32;
    const block = (type: number, body: number[]) => {
      const padded = [...body, ...new Array((4 - (body.length % 4)) % 4).fill(0)];
      const total = padded.length + 12;
      return [...w32(type), ...w32(total), ...padded, ...w32(total)];
    };
    const shb = block(0x0a0d0d0a, [...w32(0x1a2b3c4d), 1, 0, 0, 0, ...new Array(8).fill(255)]);
    // if0: Ethernet, nanoseconds (if_tsresol = 9); if1: raw IP, default microseconds
    const idb0 = block(1, [
      ...le16(1),
      0,
      0,
      ...w32(0),
      ...le16(9),
      ...le16(1),
      9,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    const idb1 = block(1, [...le16(101), 0, 0, ...w32(0)]);
    const epb = (iface: number, ticks: number, data: Uint8Array) =>
      block(6, [
        ...w32(iface),
        ...w32(Math.floor(ticks / 4294967296)),
        ...w32(ticks >>> 0),
        ...w32(data.length),
        ...w32(data.length),
        ...data,
      ]);
    const raw = ipPacket('10.9.9.9', '10.8.8.8', 17, bytes([0, 5, 0, 6, 0, 8, 0, 0]));
    const spb = block(3, [...w32(dns.length), ...dns]);
    const file = Uint8Array.from([
      ...shb,
      ...idb0,
      ...idb1,
      ...epb(0, 1_500_000_000, dns),
      ...epb(1, 2_000_000, raw),
      ...spb,
    ]);
    const a = analyze(file);
    expect(a.cap.linkTypes).toEqual([1, 101]);
    expect(a.cap.packets.map((p) => [p.link, p.iface])).toEqual([
      [1, 0],
      [101, 1],
      [1, 0],
    ]);
    expect(a.cap.packets[0]!.time).toBeCloseTo(1.5, 9); // ns resolution
    expect(a.cap.packets[1]!.time).toBeCloseTo(2, 9); // µs resolution
    expect(a.pkts[1]).toMatchObject({ src: '10.9.9.9', dst: '10.8.8.8', sport: 5, dport: 6 });
    expect(a.pkts[2]).toMatchObject({ proto: 'DNS', src: '10.0.0.1' }); // simple packet block, interface 0
    expect(a.malformed).toBe(0);
  });

  it('accepts a gzip-compressed capture', () => {
    const a = analyze(gzipSync(pcap([{ t: 1, data: dns }])));
    expect(a.cap.packets).toHaveLength(1);
    expect(a.cap.format).toContain('gzip');
  });

  it('decodes IPv6, VLAN tags, Linux cooked, loopback and raw captures', () => {
    const tcp = bytes([
      ...be16(5555),
      ...be16(443),
      ...be32(1),
      ...be32(0),
      0x50,
      0x02,
      ...be16(100),
      0,
      0,
      0,
      0,
    ]);
    const v6 = (payload: Uint8Array) =>
      bytes(
        [0x60, 0, 0, 0, ...be16(payload.length), 6, 64],
        [0x20, 0x01, 0xd, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        [0x20, 0x01, 0xd, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        payload,
      );
    const v4 = ipPacket('10.1.1.1', '10.2.2.2', 6, tcp);
    const cases: [string, number, Uint8Array, string, string][] = [
      ['IPv6 over Ethernet', 1, eth(v6(tcp), 0x86dd), '2001:db8::1', '2001:db8::2'],
      [
        '802.1Q VLAN',
        1,
        bytes([2, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 1, 0x81, 0, 0, 5, 8, 0], v4),
        '10.1.1.1',
        '10.2.2.2',
      ],
      [
        'Linux cooked SLL',
        113,
        bytes([0, 0, 0, 1, 0, 6, 2, 0, 0, 0, 0, 1, 0, 0, 8, 0], v4),
        '10.1.1.1',
        '10.2.2.2',
      ],
      [
        'Linux cooked SLL2',
        276,
        bytes([8, 0, 0, 0, 0, 0, 0, 2, 0, 1, 0, 6, 2, 0, 0, 0, 0, 1, 0, 0], v4),
        '10.1.1.1',
        '10.2.2.2',
      ],
      ['raw IPv4', 101, v4, '10.1.1.1', '10.2.2.2'],
      ['raw IPv6', 101, v6(tcp), '2001:db8::1', '2001:db8::2'],
      ['loopback (little-endian family)', 0, bytes([2, 0, 0, 0], v4), '10.1.1.1', '10.2.2.2'],
      ['loopback (big-endian family)', 0, bytes([0, 0, 0, 2], v4), '10.1.1.1', '10.2.2.2'],
      ['BSD loopback IPv6', 0, bytes([24, 0, 0, 0], v6(tcp)), '2001:db8::1', '2001:db8::2'],
    ];
    for (const [name, link, frame, src, dst] of cases) {
      const a = analyze(pcap([{ t: 1, data: frame }], { link }));
      expect(a.pkts[0], name).toMatchObject({
        src,
        dst,
        sport: 5555,
        dport: 443,
        proto: 'TCP',
        bad: false,
      });
    }
  });

  it('decodes an 802.11 data frame behind a radiotap header', () => {
    const udpBody = bytes([...be16(1000), ...be16(2000), ...be16(11), 0, 0], latin1Encode('wifi'));
    const ip = ipPacket('192.168.0.5', '192.168.0.1', 17, udpBody);
    const radiotap = [0, 0, 8, 0, 0, 0, 0, 0];
    const wlan = [
      0x08,
      0x01,
      0,
      0,
      ...[1, 1, 1, 1, 1, 1],
      ...[2, 2, 2, 2, 2, 2],
      ...[3, 3, 3, 3, 3, 3],
      0,
      0,
    ];
    const llc = [0xaa, 0xaa, 3, 0, 0, 0, 8, 0];
    const a = analyze(pcap([{ t: 1, data: bytes(radiotap, wlan, llc, ip) }], { link: 127 }));
    expect(a.pkts[0]).toMatchObject({
      src: '192.168.0.5',
      dst: '192.168.0.1',
      sport: 1000,
      dport: 2000,
    });
    const beacon = [
      0x80,
      0,
      0,
      0,
      ...new Array(6).fill(255),
      ...[9, 9, 9, 9, 9, 9],
      ...[9, 9, 9, 9, 9, 9],
      0,
      0,
      ...new Array(8).fill(0),
      100,
      0,
      1,
      4,
      0,
      4,
      ...latin1Encode('CTFnet'),
    ];
    const b = analyze(pcap([{ t: 1, data: bytes(radiotap, beacon) }], { link: 127 }));
    expect(b.pkts[0]!.proto).toBe('802.11');
    expect(b.pkts[0]!.info).toContain('Beacon');
  });

  it('reassembles IPv4 fragments', () => {
    const udpBody = bytes(
      [...be16(7), ...be16(9), ...be16(8 + 24), 0, 0],
      latin1Encode('frag{ment}-and-more-data'),
    );
    const first = udpBody.subarray(0, 16);
    const rest = udpBody.subarray(16);
    const frames = [
      eth(ipPacket('10.0.0.1', '10.0.0.2', 17, first, { id: 77, more: true })),
      eth(ipPacket('10.0.0.1', '10.0.0.2', 17, rest, { id: 77, fragOff: 16 })),
    ];
    const a = analyze(pcap(timed(frames)));
    expect(a.pkts[0]!.info).toContain('Fragmented');
    expect(latin1Decode(a.pkts[1]!.payload)).toBe('frag{ment}-and-more-data');
  });
});

// ---------- damaged input ----------

describe('pcap damaged input', () => {
  it('asks for a capture when given something else', () => {
    expect(() => run(latin1Encode('this is certainly not a capture file'))).toThrow(ToolError);
    expect(() => run(new Uint8Array(0))).toThrow(ToolError);
    expect(() => run(Uint8Array.from([0xd4, 0xc3, 0xb2, 0xa1, 2, 0, 4, 0]))).toThrow(ToolError);
  });

  it('never throws other than ToolError on a file cut at any byte', () => {
    for (const name of ['forensics-http.pcap', 'forensics-exfil.pcapng']) {
      const full = sample(name);
      const step = name.endsWith('pcap') ? 13 : 1;
      for (let n = 0; n <= full.length; n += step) {
        const cut = full.subarray(0, n);
        try {
          for (const mode of ['overview', 'streams', 'packets', 'export', 'exfil'] as const)
            run(cut, { mode });
        } catch (e) {
          expect(e, `${name} cut at ${n}`).toBeInstanceOf(ToolError);
        }
      }
    }
  });

  it('counts a truncated last record and keeps the packets before it', () => {
    const full = sample('forensics-http.pcap');
    const a = analyze(full.subarray(0, full.length - 30));
    expect(a.cap.truncated).toBe(1);
    expect(a.cap.packets).toHaveLength(58);
    expect(text(full.subarray(0, full.length - 30))).toContain('cut off');
  });

  it('survives garbage and short frames inside a valid capture', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 255;
    const recs: Rec[] = [];
    for (let i = 0; i < 300; i++) {
      const n = i % 90;
      const data = Uint8Array.from({ length: n }, rnd);
      if (i % 3 === 0 && n > 20) data.set([0x08, 0x00], 12); // claims IPv4, content is noise
      recs.push({ t: 1 + i, data });
    }
    for (const link of [1, 101, 113, 276, 0, 105, 127, 999]) {
      const file = pcap(recs, { link });
      for (const mode of ['overview', 'packets', 'streams', 'export', 'exfil'] as const) {
        expect(() => run(file, { mode })).not.toThrow();
      }
    }
    expect(text(pcap(recs, { link: 1 }))).toContain('too short or damaged');
    expect(text(pcap(recs, { link: 999 }))).toContain('not supported');
  });

  it('survives hostile fields: bad lengths, DNS pointer loops, absurd offsets', () => {
    const loop = bytes([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 1, 0, 1]); // name points at itself
    const frames = [
      udpFrame('10.0.0.1', '10.0.0.2', 1, 53, loop),
      eth(bytes([0x4f, 0, 0, 20, 0, 0, 0, 0, 64, 6, 0, 0, ...ipv4('1.1.1.1'), ...ipv4('2.2.2.2')])), // IHL 60 > frame
      eth(
        ipPacket(
          '1.1.1.1',
          '2.2.2.2',
          6,
          bytes([0, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 2, 0, 0, 0, 0, 0, 0]),
        ),
      ), // TCP data offset 60
      tcpFrame({ from: 'c', seq: 5, flags: 0x18, data: 'x' }),
      tcpFrame({ from: 'c', seq: 5 + 0x7fffffff, flags: 0x18, data: 'far away' }),
    ];
    expect(() => text(pcap(timed(frames)), { mode: 'streams' })).not.toThrow();
    expect(() => text(pcap(timed(frames)))).not.toThrow();
  });
});

// ---------- scale ----------

describe('pcap limits and speed', () => {
  it('caps the packet table at 5000 rows and says so', () => {
    const frame = udpFrame('10.0.0.1', '10.0.0.2', 1, 2, latin1Encode('x'));
    const file = pcap(Array.from({ length: 6000 }, (_, i) => ({ t: 1 + i / 1000, data: frame })));
    const out = run(file, { mode: 'packets' });
    expect(tableOf(out, 'Packets').rows).toHaveLength(5000);
    expect(resultToText(out)).toContain('first 5000 of 6000');
  });

  it('analyses a 20 MB capture in a few seconds', { timeout: 60_000 }, () => {
    // 40 connections of ~500 KB each, 1400-byte segments, interleaved, plus small noise packets
    const recs: Rec[] = [];
    const payload = latin1Encode('A'.repeat(1400));
    const conns = 40;
    const perConn = 350;
    const seq = new Array<number>(conns).fill(1000);
    for (let i = 0; i < perConn; i++) {
      for (let c = 0; c < conns; c++) {
        const cc = { ip: '10.0.0.1', port: 20000 + c };
        recs.push({
          t: 1_700_000_000 + recs.length * 1e-5,
          data: tcpFrame({ from: 's', seq: seq[c]!, flags: 0x10, data: payload }, cc),
        });
        seq[c]! += 1400;
      }
    }
    for (let i = 0; i < 20_000; i++) {
      recs.push({
        t: 1_700_001_000 + i * 1e-5,
        data: udpFrame('10.0.0.1', '10.0.0.3', 1000, 2000, latin1Encode('noise')),
      });
    }
    const file = pcap(recs);
    expect(file.length).toBeGreaterThan(19_000_000);
    const t0 = performance.now();
    for (const mode of ['overview', 'streams', 'packets', 'export'] as const) run(file, { mode });
    const secs = (performance.now() - t0) / 1000;
    expect(secs).toBeLessThan(25); // four full analyses; each should take a few seconds at most
  });
});
