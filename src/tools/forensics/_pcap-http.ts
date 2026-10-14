import { Decompress } from 'fflate';
import { indexOfBytes, latin1Decode, latin1Encode } from '../../lib/bytes';
import { joinBytes } from './_pcap-addr';

export interface HttpMessage {
  kind: 'request' | 'response';
  /** First line as sent ("GET /a HTTP/1.1", "HTTP/1.1 200 OK"). */
  startLine: string;
  method: string;
  uri: string;
  status: number;
  headers: [string, string][];
  /** Body with Transfer-Encoding (chunked) and Content-Encoding (gzip, deflate) removed. */
  body: Uint8Array;
  /** What was done to the body, or what went wrong: "chunked", "gzip", "body cut off"... */
  notes: string[];
  /** Offset in the reassembled stream where the message started. */
  offset: number;
}

/** Refuse to inflate more than this (zip-bomb guard). */
const MAX_INFLATED = 64 * 1024 * 1024;
const MAX_HEAD = 64 * 1024;

const REQUEST_LINE = /^([A-Z]{3,10}) (\S+) HTTP\/\d\.\d$/;
const RESPONSE_LINE = /^HTTP\/\d\.\d (\d{3})(?: .*)?$/;
const METHODS = new Set([
  'GET',
  'POST',
  'HEAD',
  'PUT',
  'DELETE',
  'OPTIONS',
  'PATCH',
  'CONNECT',
  'TRACE',
]);

const CRLFCRLF = [13, 10, 13, 10];
const LFLF = [10, 10];

const isUpper = (c: number | undefined) => c !== undefined && c >= 65 && c <= 90;

/** Cheap check on the first bytes: does this look like the start of an HTTP/1.x request? */
export function looksLikeHttpRequest(b: Uint8Array): boolean {
  let i = 0;
  while (i < 8 && isUpper(b[i])) i++;
  if (i < 3 || b[i] !== 0x20) return false;
  return METHODS.has(latin1Decode(b.subarray(0, i)));
}

export function looksLikeHttpResponse(b: Uint8Array): boolean {
  return b.length >= 12 && latin1Decode(b.subarray(0, 5)) === 'HTTP/' && b[6] === 0x2e;
}

export function headerOf(m: { headers: [string, string][] }, name: string): string | undefined {
  const n = name.toLowerCase();
  for (const [k, v] of m.headers) if (k.toLowerCase() === n) return v;
  return undefined;
}

function decodeChunked(
  data: Uint8Array,
  start: number,
): { body: Uint8Array; next: number; complete: boolean } {
  const parts: Uint8Array[] = [];
  let p = start;
  for (;;) {
    const nl = indexOfBytes(data, [10], p);
    if (nl < 0 || nl - p > 64)
      return { body: joinBytes(parts), next: data.length, complete: false };
    const size = parseInt(latin1Decode(data.subarray(p, nl)).split(';')[0]!.trim(), 16);
    if (Number.isNaN(size)) return { body: joinBytes(parts), next: data.length, complete: false };
    p = nl + 1;
    if (size === 0) {
      // trailers end with an empty line
      for (;;) {
        const e = indexOfBytes(data, [10], p);
        if (e < 0) return { body: joinBytes(parts), next: data.length, complete: true };
        const blank = e - p <= 1;
        p = e + 1;
        if (blank) return { body: joinBytes(parts), next: p, complete: true };
      }
    }
    if (p + size > data.length) {
      parts.push(data.subarray(p));
      return { body: joinBytes(parts), next: data.length, complete: false };
    }
    parts.push(data.subarray(p, p + size));
    p += size;
    if (data[p] === 13) p++;
    if (data[p] === 10) p++;
  }
}

/** gzip / zlib / raw deflate, auto-detected. Truncated streams give what could be decoded. */
function inflate(body: Uint8Array): Uint8Array | null {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const d = new Decompress((chunk) => {
      total += chunk.length;
      if (total > MAX_INFLATED) throw new Error('inflated body too large');
      chunks.push(chunk);
    });
    d.push(body, true);
  } catch {
    return chunks.length ? joinBytes(chunks) : null;
  }
  return joinBytes(chunks);
}

function parseHead(
  text: string,
  kind: 'request' | 'response',
): {
  start: string;
  headers: [string, string][];
  method: string;
  uri: string;
  status: number;
} | null {
  const lines = text.split(/\r?\n/);
  const start = lines[0] ?? '';
  let method = '';
  let uri = '';
  let status = 0;
  if (kind === 'request') {
    const m = REQUEST_LINE.exec(start);
    if (!m || !METHODS.has(m[1]!)) return null;
    method = m[1]!;
    uri = m[2]!;
  } else {
    const m = RESPONSE_LINE.exec(start);
    if (!m) return null;
    status = Number(m[1]);
  }
  const headers: [string, string][] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const c = line.indexOf(':');
    if (c > 0) headers.push([line.slice(0, c).trim(), line.slice(c + 1).trim()]);
  }
  return { start, headers, method, uri, status };
}

/**
 * Parse every HTTP/1.x message of one direction of a reassembled TCP stream (pipelining and
 * keep-alive give several). Stops at the first byte that does not start a message.
 * `requestMethods` are the methods of the requests that were answered, in order: it tells
 * responses to HEAD (no body) apart.
 */
export function parseHttpStream(
  data: Uint8Array,
  kind: 'request' | 'response',
  requestMethods: string[] = [],
): HttpMessage[] {
  const out: HttpMessage[] = [];
  let pos = 0;
  while (pos < data.length) {
    while (data[pos] === 13 || data[pos] === 10) pos++;
    if (pos >= data.length) break;
    // Only look a header's length ahead: scanning to the end of the stream per message is O(n^2).
    const view = data.subarray(0, Math.min(data.length, pos + MAX_HEAD + 4));
    let end = indexOfBytes(view, CRLFCRLF, pos);
    let sep = 4;
    const lf = indexOfBytes(end < 0 ? view : view.subarray(0, end), LFLF, pos);
    if (lf >= 0) {
      end = lf;
      sep = 2;
    }
    if (end < 0) break;
    const head = parseHead(latin1Decode(data.subarray(pos, end)), kind);
    if (!head) break;
    const bodyStart = end + sep;
    const notes: string[] = [];
    const msg: HttpMessage = {
      kind,
      startLine: head.start,
      method: head.method,
      uri: head.uri,
      status: head.status,
      headers: head.headers,
      body: new Uint8Array(0),
      notes,
      offset: pos,
    };
    const te = (headerOf(msg, 'transfer-encoding') ?? '').toLowerCase();
    const cl = headerOf(msg, 'content-length');
    const answeredMethod = requestMethods[out.length] ?? '';
    const noBody =
      kind === 'response' &&
      (answeredMethod === 'HEAD' ||
        head.status < 200 ||
        head.status === 204 ||
        head.status === 304);
    let raw: Uint8Array;
    let next: number;
    if (noBody) {
      raw = new Uint8Array(0);
      next = bodyStart;
    } else if (te.includes('chunked')) {
      const c = decodeChunked(data, bodyStart);
      raw = c.body;
      next = c.next;
      notes.push('chunked');
      if (!c.complete) notes.push('body cut off');
    } else if (cl !== undefined && /^\d+$/.test(cl)) {
      const want = Number(cl);
      next = Math.min(bodyStart + want, data.length);
      raw = data.subarray(bodyStart, next);
      if (raw.length < want) notes.push('body cut off');
    } else if (kind === 'request') {
      raw = new Uint8Array(0);
      next = bodyStart;
    } else {
      raw = data.subarray(bodyStart); // response delimited by connection close
      next = data.length;
    }
    const enc = (headerOf(msg, 'content-encoding') ?? '').toLowerCase();
    if (raw.length && /gzip|deflate|x-gzip/.test(enc)) {
      const plain = inflate(raw);
      if (plain) {
        notes.push(enc.includes('gzip') ? 'gunzipped' : 'inflated');
        raw = plain;
      } else {
        notes.push(`${enc} body could not be decompressed`);
      }
    }
    msg.body = raw;
    out.push(msg);
    pos = next;
  }
  return out;
}

export interface MultipartPart {
  name: string;
  filename: string | null;
  contentType: string;
  data: Uint8Array;
}

/** Parts of a multipart/form-data (or mixed) body: uploaded files and form fields. */
export function parseMultipart(body: Uint8Array, contentType: string): MultipartPart[] {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return [];
  const delim = latin1Encode(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let pos = indexOfBytes(body, delim, 0);
  while (pos >= 0) {
    pos += delim.length;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing delimiter
    if (body[pos] === 13) pos++;
    if (body[pos] === 10) pos++;
    const next = indexOfBytes(body, delim, pos);
    const stop = next < 0 ? body.length : next;
    const split = indexOfBytes(body.subarray(0, stop), CRLFCRLF, pos);
    if (split >= 0) {
      const head = latin1Decode(body.subarray(pos, split));
      let dataEnd = stop;
      if (body[dataEnd - 1] === 10) dataEnd--;
      if (body[dataEnd - 1] === 13) dataEnd--;
      const disp = /content-disposition:[^\r\n]*/i.exec(head)?.[0] ?? '';
      parts.push({
        name: /\bname="([^"]*)"/i.exec(disp)?.[1] ?? '',
        filename: /filename="([^"]*)"/i.exec(disp)?.[1] ?? null,
        contentType: /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1]?.trim() ?? '',
        data: body.subarray(split + 4, Math.max(split + 4, dataEnd)),
      });
    }
    pos = next;
  }
  return parts;
}
