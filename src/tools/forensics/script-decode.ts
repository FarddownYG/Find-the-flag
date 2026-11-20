import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { Output, Sample } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import { utf8Encode } from '../../lib/bytes';
import { decodeScriptEncoder, hasScriptEncoder, type ScriptBlock } from './_script-encoder';

const T = toolT('script-decode');

const DETECT_LIMIT = 200_000;

/**
 * What to do with the decoded script: run every tool's own detector over it (the same vote the
 * home page uses) and offer the ones that recognise it, best first, carrying their preselected
 * options. This is how the decoder points at the next tool — a base64 blob, more obfuscated JS, a
 * source map, hidden characters — instead of guessing.
 */
function suggestNext(decoded: string): Output[] {
  const sample: Sample = { text: decoded, bytes: utf8Encode(decoded.slice(0, DETECT_LIMIT)) };
  const hits = registeredTools()
    .filter((t) => t.id !== 'script-decode' && typeof t.detect === 'function')
    .map((t) => {
      try {
        const d = t.detect!(sample);
        return d && d.score >= 0.3 ? { tool: t, d } : null;
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.d.score - a.d.score)
    .slice(0, 5);

  // Fall back to the tools that simply read any script, when no detector fired.
  if (!hits.length) {
    const tools = registeredTools();
    const actions = ['js-deobfuscate', 'web-source', 'strings']
      .map((id) => tools.find((t) => t.id === id))
      .filter((t): t is NonNullable<typeof t> => !!t)
      .map((t) => ({
        label: T('action.open', { tool: toolName(t) }),
        options: {},
        open: { tool: t.id, text: decoded },
      }));
    return actions.length ? [{ type: 'actions', label: T('label.related'), actions }] : [];
  }

  return [
    { type: 'note', level: 'info', text: T('note.next') },
    {
      type: 'actions',
      label: T('label.next'),
      actions: hits.map(({ tool, d }) => ({
        label: d.reason
          ? T('action.openWhy', { tool: toolName(tool), why: d.reason })
          : T('action.open', { tool: toolName(tool) }),
        options: (d.options ?? {}) as Record<string, unknown>,
        open: { tool: tool.id, text: decoded },
      })),
    },
  ];
}

export default defineTool({
  id: 'script-decode',
  name: 'Script Encoder decoder (JScript / VBScript.Encode)',
  category: 'forensics',
  description:
    'Decode a Microsoft Script Encoder block (#@~^…^#~@, the output of screnc.exe) back to the JScript or VBScript it hides. 100% offline.',
  tags: [
    'jscript.encode',
    'vbscript.encode',
    'script encoder',
    'screnc',
    'scrdec',
    'decode-vbe',
    'encoded script',
    'htm encode',
    'hta',
    'malware',
    'deobfuscate',
    'microsoft',
    '#@~^',
  ],
  input: 'text',
  placeholder: 'Paste an encoded block: #@~^……==…==^#~@ (or a whole page that contains one)',
  examples: [
    {
      label: 'JScript.Encode',
      input: '#@~^HQAAAA==C^+.D`EsKw\x09NdmMk2Y|+U^KN+)v#plgoAAA==^#~@',
      expect: 'FTF{jscript_encode}',
    },
    {
      label: 'VBScript.Encode',
      input: '#@~^FAAAAA==\x09Um.bwDR21tK~J4+sVKJ8QYAAA==^#~@',
      expect: 'WScript.Echo',
    },
  ],
  detect({ text }) {
    if (!text || !hasScriptEncoder(text)) return null;
    return { score: 0.95, reason: T('detect.reason') };
  },
  run(text) {
    const blocks = decodeScriptEncoder(text);
    if (!blocks.length) throw new ToolError(T('err.none'));
    const out: Output[] = [{ type: 'note', level: 'info', text: T('note.what') }];
    const sumNote = (b: ScriptBlock): Output => {
      if (b.checksum === 'bad') {
        return { type: 'note', level: 'warn', text: T('note.badSum', { len: b.length }) };
      }
      const key = b.checksum === 'ok' ? 'note.okSum' : 'note.noSum';
      return { type: 'note', level: 'info', text: T(key, { len: b.length }) };
    };
    blocks.forEach((b, i) => {
      if (b.truncated) {
        out.push({
          type: 'note',
          level: 'warn',
          text: T('note.truncated', { got: b.script.length }),
        });
      } else {
        out.push(sumNote(b));
      }
      out.push({
        type: 'text',
        label: blocks.length > 1 ? T('label.block', { n: i + 1 }) : T('label.script'),
        value: b.script,
      });
    });
    out.push(...suggestNext(blocks[0]!.script));
    out.push({ type: 'note', level: 'info', text: T('note.static') });
    return out;
  },
});
