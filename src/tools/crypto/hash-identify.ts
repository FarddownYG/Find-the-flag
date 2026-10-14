import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { Output } from '../../core/types';
import { tOr } from '../../i18n';
import { slug, toolT } from '../../i18n/tool-text';
import { FORMATS, confidenceLabel, identify, type Identification } from './_hash-formats';

const T = toolT('hash-identify');
/** Fixed English strings of the format database, translated by a key derived from the text. */
const tr = (area: string, english: string) =>
  tOr(`tool.hash-identify.${area}.${slug(english)}`, english);

/** Format notes: a few carry data (decoded hex / plaintext) and get a key with a placeholder. */
function noteText(note: string): string {
  const hexNote = note.match(/^decodes to hex ([0-9a-f]+)$/);
  if (hexNote) return T('note.decodesHex', { hex: hexNote[1]! });
  const plain = note.match(/^Not a hash: decodes to "(.*)"$/s);
  if (plain) return T('note.ciscoPlain', { plain: plain[1]! });
  return note ? tr('format', note) : '';
}

const MAX_LINES = 1000;
const MAX_DETAILED = 25;

const dash = (s: string) => s || '-';

function short(s: string): string {
  return s.length > 44 ? `${s.slice(0, 28)}…${s.slice(-10)}` : s;
}

function describeShape(s: string): string {
  const kind = /^[0-9a-f]+$/i.test(s)
    ? 'hex'
    : /^[A-Za-z0-9+/=_-]+$/.test(s)
      ? 'Base64-like'
      : /^[\x20-\x7e]+$/.test(s)
        ? 'printable text'
        : 'non-printable characters';
  return T('shape', {
    count: s.length,
    kind: T(
      `kind.${kind === 'Base64-like' ? 'base64' : kind === 'printable text' ? 'printable' : kind === 'non-printable characters' ? 'binary' : 'hex'}`,
    ),
  });
}

function lineBlocks(id: Identification, label: string): Output[] {
  const out: Output[] = [];
  const top = id.candidates[0];
  if (!top) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.noMatch', { label, shape: describeShape(id.hash) }),
    });
  } else {
    const withNotes = id.candidates.some((c) => c.note);
    out.push({
      type: 'table',
      label,
      columns: [
        T('col.candidate'),
        'Hashcat -m',
        T('col.john'),
        T('col.confidence'),
        ...(withNotes ? [T('col.notes')] : []),
      ],
      rows: id.candidates.map((c) => [
        c.name,
        dash(c.hashcat),
        dash(c.john),
        tr('confidence', confidenceLabel(c.confidence)),
        ...(withNotes ? [noteText(c.note)] : []),
      ]),
      highlight: [0],
    });
  }
  for (const c of id.contextKeys) {
    out.push({ type: 'note', level: 'info', text: T(`context.${c.key}`, c.params) });
  }
  if (id.known) {
    out.push({
      type: 'note',
      level: 'success',
      text: T('note.known', { value: tr('known', id.known) }),
    });
  }
  if (top && FORMATS.some((f) => f.jwt && f.name === top.name)) {
    out.push({
      type: 'note',
      level: 'info',
      text: T('note.jwt'),
    });
  }
  return out;
}

export default defineTool({
  id: 'hash-identify',
  name: 'Hash identifier',
  category: 'crypto',
  description:
    'Tell which hash a string is (MD5, NTLM, bcrypt, sha512crypt, Kerberos...) and get the hashcat and John names.',
  tags: [
    'hashid',
    'name-that-hash',
    'hash-identifier',
    'identify hash',
    'hashcat',
    'john',
    'jtr',
    'shadow',
    'ntlm',
    'bcrypt',
    'md5',
    'sha1',
    'sha256',
    'crypt',
    'kerberoast',
  ],
  input: 'text',
  placeholder: '5f4dcc3b5aa765d61d8327deb882cf99\n$6$salt$…\nroot:$y$…:19000:0:99999:7:::',
  live: true,
  examples: [
    {
      label: 'A 32-hex hash',
      input: '5f4dcc3b5aa765d61d8327deb882cf99',
      expect: 'raw-md5',
    },
    {
      label: 'bcrypt',
      input: '$2a$05$LhayLxezLhK1LhWvKxCyLOj0j1u.Kj0jZ0pEmm134uzrQlFvQJLF6',
      expect: 'bcrypt',
    },
    {
      label: '/etc/shadow line',
      input:
        'root:$6$52450745$k5ka2p8bFuSmoVT1tzOyyuaREkkKBcCNqoDKzYiJL9RaE8yMnPgh2XzzF0NDrUhgrcLwg78xs1w5pJiypEdFX/:19000:0:99999:7:::',
      expect: 'sha512crypt',
    },
    {
      label: 'Several hashes at once',
      input: 'da39a3ee5e6b4b0d3255bfef95601890afd80709\n$apr1$71850310$gh9m4xcAn3MGxogwX/ztb.',
      expect: 'Apache apr1',
    },
    { label: 'Cisco type 7 decodes', input: '02050D480809', expect: 'decodes to "cisco"' },
    {
      label: 'Windows dump line',
      input:
        'Administrator:500:aad3b435b51404eeaad3b435b51404ee:8846f7eaee8fb117ad06bdd830b7586c:::',
      expect: 'pwdump / secretsdump line',
    },
  ],
  detect({ text }) {
    const t = text?.trim();
    if (!t || t.length > 20000) return null;
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0 || lines.length > 50) return null;
    let worst = 100;
    for (const line of lines) {
      if (line.trim().length < 20) return null;
      const top = identify(line).candidates[0];
      if (!top || top.confidence < 55) return null;
      if (FORMATS.some((f) => f.jwt && f.name === top.name)) return null;
      worst = Math.min(worst, top.confidence);
    }
    const score = worst >= 95 ? 0.92 : worst >= 80 ? 0.85 : 0.65;
    return { score, reason: T('detect.reason') };
  },
  run(text) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) throw new ToolError(T('error.empty'));
    const used = lines.slice(0, MAX_LINES);
    const results = used.map((l) => identify(l));
    const out: Output[] = [];

    if (results.length > MAX_DETAILED) {
      out.push({
        type: 'table',
        label: T('label.many', { count: results.length }),
        columns: ['#', 'Hash', T('col.best'), 'Hashcat -m', T('col.john'), T('col.confidence')],
        rows: results.map((r, i) => {
          const top = r.candidates[0];
          return [
            i + 1,
            short(r.hash),
            top?.name ?? T('value.unknown'),
            dash(top?.hashcat ?? ''),
            dash(top?.john ?? ''),
            top ? tr('confidence', confidenceLabel(top.confidence)) : '-',
          ];
        }),
      });
      out.push({
        type: 'note',
        level: 'info',
        text: T('note.tooMany', { max: MAX_DETAILED }),
      });
    } else {
      results.forEach((r, i) => {
        const label =
          results.length === 1
            ? T('label.candidates', { hash: short(r.hash) })
            : T('label.line', { line: i + 1, hash: short(r.hash) });
        out.push(...lineBlocks(r, label));
      });
    }
    if (lines.length > MAX_LINES) {
      out.push({
        type: 'note',
        level: 'warn',
        text: T('note.truncated', { max: MAX_LINES, count: lines.length }),
      });
    }
    return out;
  },
});
