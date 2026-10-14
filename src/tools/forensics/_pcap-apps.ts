import { fromBase64, latin1Decode, u16be } from '../../lib/bytes';
import { printable } from './_pcap-addr';
import { TCP_PORTS } from './_pcap-decode';
import {
  headerOf,
  looksLikeHttpRequest,
  looksLikeHttpResponse,
  type HttpMessage,
} from './_pcap-http';
import type { Stream } from './_pcap-streams';

export interface Credential {
  proto: string;
  /** "ip:port" of the server. */
  server: string;
  user: string;
  secret: string;
  stream: number;
}

const startsWith = (b: Uint8Array, text: string): boolean => {
  if (b.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[i] !== text.charCodeAt(i)) return false;
  return true;
};

const isTls = (b: Uint8Array): boolean =>
  b.length >= 5 && b[0]! >= 0x14 && b[0]! <= 0x17 && b[1] === 3 && b[2]! <= 4;

/** DNS over TCP: a 2-byte length precedes every message. */
const isTcpDns = (c: Uint8Array, port: number): boolean =>
  port === 53 && c.length >= 14 && u16be(c, 0) <= c.length - 2;

/** Work out the application protocol of a stream from what was actually said, then the port. */
export function classifyStream(s: Stream): string {
  if (s.transport === 'UDP') return s.proto;
  const c = s.c2s;
  const r = s.s2c;
  const hasData = c.length + r.length > 0;
  let proto: string;
  if (looksLikeHttpRequest(c) || looksLikeHttpResponse(r)) proto = 'HTTP';
  else if (isTls(c) || (!c.length && isTls(r))) proto = 'TLS';
  else if (startsWith(c, 'SSH-') || startsWith(r, 'SSH-')) proto = 'SSH';
  else if (startsWith(r, '220')) {
    if (/^(EHLO|HELO)/i.test(latin1Decode(c.subarray(0, 5)))) proto = 'SMTP';
    else if (s.serverPort === 25 || s.serverPort === 587) proto = 'SMTP';
    else proto = 'FTP';
  } else if (startsWith(r, '+OK')) proto = 'POP';
  else if (startsWith(r, '* OK') || startsWith(r, '* PREAUTH')) proto = 'IMAP';
  else if (isTcpDns(c, s.serverPort)) proto = 'DNS';
  else if (c[0] === 0xff && c[1]! >= 0xfb) proto = 'Telnet';
  else if (r[0] === 0xff && r[1]! >= 0xfb) proto = 'Telnet';
  else if (!hasData) proto = TCP_PORTS[s.serverPort] ?? 'TCP';
  else if (s.serverPort === 23) proto = 'Telnet';
  else if (s.serverPort === 445 || s.serverPort === 3389) proto = TCP_PORTS[s.serverPort]!;
  else proto = 'TCP';
  s.proto = proto;
  return proto;
}

// ---------- TLS ----------

/** Server name from a TLS ClientHello at the start of `b`, or null. */
export function tlsSni(b: Uint8Array): string | null {
  if (b.length < 48 || b[0] !== 0x16 || b[1] !== 3 || b[5] !== 1) return null;
  let p = 5 + 4 + 2 + 32; // record + handshake header, version, random
  const need = (n: number) => p + n <= b.length;
  if (!need(1)) return null;
  p += 1 + b[p]!;
  if (!need(2)) return null;
  p += 2 + u16be(b, p);
  if (!need(1)) return null;
  p += 1 + b[p]!;
  if (!need(2)) return null;
  const end = Math.min(b.length, p + 2 + u16be(b, p));
  p += 2;
  while (p + 4 <= end) {
    const type = u16be(b, p);
    const len = u16be(b, p + 2);
    p += 4;
    if (type === 0 && len >= 5 && p + 5 <= end) {
      const nameLen = u16be(b, p + 3);
      if (b[p + 2] === 0 && p + 5 + nameLen <= b.length) {
        return printable(latin1Decode(b.subarray(p + 5, p + 5 + nameLen)));
      }
      return null;
    }
    p += len;
  }
  return null;
}

// ---------- cleartext protocols ----------

interface LineEvent {
  /** 0 = client to server. */
  dir: 0 | 1;
  line: string;
}

function lineEvents(s: Stream): LineEvent[] {
  const out: LineEvent[] = [];
  for (const b of s.blocks) {
    const lines = latin1Decode(b.data).split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) out.push({ dir: b.dir, line });
  }
  return out;
}

function b64Text(s: string): string | null {
  try {
    return printable(latin1Decode(fromBase64(s)));
  } catch {
    return null;
  }
}

/** SASL PLAIN: [authzid] NUL user NUL password. */
function saslPlain(s: string): { user: string; pass: string } | null {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(s);
  } catch {
    return null;
  }
  const parts = latin1Decode(bytes).split('\0');
  if (parts.length >= 3) return { user: printable(parts[1]!), pass: printable(parts[2]!) };
  if (parts.length === 2) return { user: printable(parts[0]!), pass: printable(parts[1]!) };
  return null;
}

const unquote = (s: string): string => s.replace(/^"(.*)"$/, '$1');

/**
 * Telnet logins: the client types the username after a "login:" prompt and the password after
 * "Password:". Keystrokes usually arrive one byte per packet, interleaved with the echo.
 */
function telnetCredentials(s: Stream): { user: string; pass: string }[] {
  const out: { user: string; pass: string }[] = [];
  let tail = '';
  let expect: 'user' | 'pass' | null = null;
  let user = '';
  let line = '';
  for (const b of s.blocks) {
    const data = stripTelnet(b.data);
    if (b.dir === 1) {
      tail = (tail + latin1Decode(data)).slice(-80);
      if (/(login|user ?name|user)\s*:\s*$/i.test(tail)) {
        expect = 'user';
        line = '';
      } else if (/pass(word|phrase)?\s*:\s*$/i.test(tail)) {
        expect = 'pass';
        line = '';
      }
      continue;
    }
    for (const c of data) {
      if (c === 0x0d || c === 0x0a) {
        if (line && expect === 'user') user = line;
        else if (line && expect === 'pass') out.push({ user, pass: line });
        if (line) expect = null;
        line = '';
      } else if (c === 0x08 || c === 0x7f) line = line.slice(0, -1);
      else if (c >= 0x20 && c < 0x7f && expect) line += String.fromCharCode(c);
    }
  }
  return out;
}

/** Remove Telnet option negotiation (IAC sequences) from a data stream. */
export function stripTelnet(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i]!;
    if (c !== 0xff) {
      out[n++] = c;
      continue;
    }
    const cmd = b[i + 1];
    if (cmd === 0xff) {
      out[n++] = 0xff;
      i++;
    } else if (cmd !== undefined && cmd >= 0xfb && cmd <= 0xfe) i += 2;
    else if (cmd === 250) {
      // subnegotiation runs until IAC SE
      let j = i + 2;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] === 240)) j++;
      i = j + 1;
    } else i++;
  }
  return out.subarray(0, n);
}

/** Logins sent in the clear over FTP, SMTP, POP3, IMAP and Telnet. */
export function cleartextCredentials(s: Stream): Credential[] {
  if (s.transport !== 'TCP') return [];
  const server = `${s.serverIp}:${s.serverPort}`;
  const make = (proto: string, user: string, secret: string): Credential => ({
    proto,
    server,
    user,
    secret,
    stream: s.index,
  });
  const out: Credential[] = [];
  switch (s.proto) {
    case 'Telnet':
      for (const c of telnetCredentials(s)) out.push(make('Telnet', c.user, c.pass));
      break;
    case 'FTP':
    case 'POP': {
      let user = '';
      for (const e of lineEvents(s)) {
        if (e.dir !== 0) continue;
        const m = /^(USER|PASS)\s+(.*)$/i.exec(e.line);
        if (!m) continue;
        if (m[1]!.toUpperCase() === 'USER') user = m[2]!;
        else out.push(make(s.proto === 'FTP' ? 'FTP' : 'POP3', user, m[2]!));
      }
      break;
    }
    case 'SMTP':
    case 'IMAP': {
      let state: '' | 'login-user' | 'login-pass' | 'plain' = '';
      let user = '';
      for (const e of lineEvents(s)) {
        if (e.dir !== 0) continue;
        const label = s.proto;
        if (state === 'login-user') {
          user = b64Text(e.line.trim()) ?? e.line;
          state = 'login-pass';
          continue;
        }
        if (state === 'login-pass') {
          out.push(make(label, user, b64Text(e.line.trim()) ?? e.line));
          state = '';
          continue;
        }
        if (state === 'plain') {
          const p = saslPlain(e.line.trim());
          if (p) out.push(make(label, p.user, p.pass));
          state = '';
          continue;
        }
        const auth = /^(?:\S+ )?AUTH(?:ENTICATE)? (LOGIN|PLAIN)(?: (\S+))?$/i.exec(e.line);
        if (auth) {
          const inline = auth[2];
          if (auth[1]!.toUpperCase() === 'LOGIN') {
            if (inline) {
              user = b64Text(inline) ?? inline;
              state = 'login-pass';
            } else state = 'login-user';
          } else if (inline) {
            const p = saslPlain(inline);
            if (p) out.push(make(label, p.user, p.pass));
          } else state = 'plain';
          continue;
        }
        const login = /^\S+ LOGIN\s+("[^"]*"|\S+)\s+("[^"]*"|\S+)/i.exec(e.line);
        if (login) out.push(make('IMAP', unquote(login[1]!), unquote(login[2]!)));
      }
      break;
    }
  }
  return out;
}

// ---------- FTP data connections ----------

export interface FtpTransfer {
  control: Stream;
  data: Stream;
  /** File name from RETR/STOR, or "listing" for LIST/NLST. */
  name: string;
  upload: boolean;
}

interface Endpoint {
  ip: string;
  port: number;
}

/** Match RETR/STOR/LIST commands to the data connection announced by PASV/PORT. */
export function findFtpTransfers(streams: Stream[]): FtpTransfer[] {
  const out: FtpTransfer[] = [];
  const used = new Set<number>();
  for (const control of streams) {
    if (control.proto !== 'FTP') continue;
    let pending: Endpoint | null = null;
    for (const e of lineEvents(control)) {
      if (e.dir === 1) {
        const pasv = /^227 .*?\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(e.line);
        const epsv = /^229 .*?\(\|\|\|(\d+)\|\)/.exec(e.line);
        if (pasv) {
          const ip = `${pasv[1]}.${pasv[2]}.${pasv[3]}.${pasv[4]}`;
          pending = { ip, port: Number(pasv[5]) * 256 + Number(pasv[6]) };
        } else if (epsv) pending = { ip: control.serverIp, port: Number(epsv[1]) };
        continue;
      }
      const port = /^PORT\s+(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/i.exec(e.line);
      const eprt = /^EPRT\s+\|\d\|([^|]*)\|(\d+)\|/i.exec(e.line);
      if (port) {
        pending = {
          ip: `${port[1]}.${port[2]}.${port[3]}.${port[4]}`,
          port: Number(port[5]) * 256 + Number(port[6]),
        };
        continue;
      }
      if (eprt) {
        pending = { ip: eprt[1]!, port: Number(eprt[2]) };
        continue;
      }
      const cmd = /^(RETR|STOR|STOU|APPE|LIST|NLST|MLSD)(?:\s+(.*))?$/i.exec(e.line);
      if (!cmd || !pending) continue;
      const ep: Endpoint = pending;
      pending = null;
      const data = streams.find(
        (d) =>
          d.transport === 'TCP' &&
          d !== control &&
          !used.has(d.index) &&
          d.firstTime >= control.firstTime &&
          d.serverPort === ep.port &&
          (d.serverIp === ep.ip ||
            d.serverIp === control.serverIp ||
            d.serverIp === control.clientIp),
      );
      if (!data) continue;
      used.add(data.index);
      const verb = cmd[1]!.toUpperCase();
      const arg = (cmd[2] ?? '').trim();
      out.push({
        control,
        data,
        name:
          verb === 'RETR' || verb === 'STOR' || verb === 'STOU' || verb === 'APPE'
            ? arg
            : 'listing',
        upload: verb === 'STOR' || verb === 'STOU' || verb === 'APPE',
      });
    }
  }
  return out;
}

// ---------- HTTP credentials ----------

const USER_KEY = /^(user(name)?|login|email|uname|usr|account|j_username)$/i;
const PASS_KEY = /^(pass(word|wd|phrase)?|pwd|secret|j_password)$/i;

function urlDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function fromPairs(pairs: [string, string][]): { user: string; pass: string } | null {
  const pass = pairs.find(([k]) => PASS_KEY.test(k));
  if (!pass) return null;
  const user = pairs.find(([k]) => USER_KEY.test(k));
  return { user: user?.[1] ?? '', pass: pass[1] };
}

const queryPairs = (q: string): [string, string][] =>
  q
    .split('&')
    .filter(Boolean)
    .map((kv) => {
      const i = kv.indexOf('=');
      return i < 0 ? [urlDecode(kv), ''] : [urlDecode(kv.slice(0, i)), urlDecode(kv.slice(i + 1))];
    });

/** Basic auth headers, login forms (POST body or query string) and JSON logins. */
export function httpCredentials(req: HttpMessage, server: string, stream: number): Credential[] {
  const out: Credential[] = [];
  const add = (user: string, secret: string, how: string) =>
    out.push({ proto: `HTTP ${how}`, server, user, secret, stream });
  for (const h of ['authorization', 'proxy-authorization']) {
    const v = headerOf(req, h);
    const m = v ? /^Basic\s+(\S+)/i.exec(v) : null;
    const text = m ? b64Text(m[1]!) : null;
    if (text !== null) {
      const i = text.indexOf(':');
      add(i < 0 ? text : text.slice(0, i), i < 0 ? '' : text.slice(i + 1), 'Basic');
    }
  }
  const q = req.uri.indexOf('?');
  const fromQuery = q >= 0 ? fromPairs(queryPairs(req.uri.slice(q + 1))) : null;
  if (fromQuery) add(fromQuery.user, fromQuery.pass, 'query');
  if (req.body.length && req.body.length < 8192) {
    const body = latin1Decode(req.body);
    const type = (headerOf(req, 'content-type') ?? '').toLowerCase();
    if (type.includes('json') || body.trimStart().startsWith('{')) {
      const u = /"(?:user(?:name)?|login|email)"\s*:\s*"([^"]*)"/i.exec(body);
      const p = /"(?:pass(?:word)?|pwd)"\s*:\s*"([^"]*)"/i.exec(body);
      if (p) add(u?.[1] ?? '', p[1]!, 'JSON');
    } else if (type.includes('x-www-form-urlencoded') || /^[\w.-]+=/.test(body)) {
      const f = fromPairs(queryPairs(body.trim()));
      if (f) add(f.user, f.pass, 'form');
    }
  }
  return out;
}
