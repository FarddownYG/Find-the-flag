import { defineTool } from '../../core/define';
import { ToolError } from '../../core/errors';
import { registeredTools } from '../../core/tool-list';
import type { Output } from '../../core/types';
import { toolName, toolT } from '../../i18n/tool-text';
import { decodeScriptEncoder, hasScriptEncoder, type ScriptBlock } from './_script-encoder';

const T = toolT('script-decode');

/** Links to the tools that read the decoded script further. */
function related(firstScript: string): Output[] {
  const tools = registeredTools();
  const actions: Extract<Output, { type: 'actions' }>['actions'] = [];
  for (const id of ['js-deobfuscate', 'web-source', 'strings']) {
    const tool = tools.find((t) => t.id === id);
    if (tool) {
      actions.push({
        label: T('action.open', { tool: toolName(tool) }),
        options: {},
        open: { tool: id, text: firstScript },
      });
    }
  }
  return actions.length ? [{ type: 'actions', label: T('label.related'), actions }] : [];
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
          text: T('note.truncated', { got: b.script.length, len: b.length }),
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
    out.push(...related(blocks[0]!.script));
    out.push({ type: 'note', level: 'info', text: T('note.static') });
    return out;
  },
});
