import { bool, defineTool, number } from '../../core/define';
import { ToolError } from '../../core/errors';
import type { GalleryItem, Output } from '../../core/types';
import { buildWriteup, mdTable, type WriteupSection } from '../../core/writeup';
import { toolT } from '../../i18n/tool-text';
import { buildVisuals } from './_image-lab-visuals';
import {
  analyzerOutputs,
  infoOutputs,
  lsbOutputs,
  passwordOutputs,
  stringsOutputs,
  structureOutputs,
} from './_image-lab-text';
import { fitImage, fitPixels } from './_pixels';

const T = toolT('image-lab');

const DEFAULT_SIDE = 1200;

export default defineTool({
  id: 'image-lab',
  name: 'Complete image analysis',
  category: 'stego',
  description:
    'Aperi’Solve-style lab that never uploads your image: every bit plane, colour remap and filter in a viewer, a "look first" triage, metadata, structure and repair, LSB scan, strings and password-tool commands.',
  tags: [
    'aperisolve',
    'aperi solve',
    'stegsolve',
    'zsteg',
    'steghide',
    'outguess',
    'openstego',
    'bit plane',
    'lsb',
    'exif',
    'png',
    'jpeg',
    'image forensics',
    'steganography',
    'complete analysis',
  ],
  input: 'image',
  placeholder: 'Drop an image (PNG, JPEG, BMP, GIF, WebP): it never leaves this tab',
  options: {
    maxSide: number('Largest side analysed (px)', DEFAULT_SIDE, {
      min: 200,
      max: 2000,
      hint: 'Bigger pictures are shrunk to this before the planes are drawn. The LSB scan always reads every pixel.',
    }),
    minLength: number('Minimum string length', 8, { min: 3, max: 200 }),
    showAll: bool('Show every line', false, {
      hint: 'Lift the cap on the LSB scan and strings tables.',
    }),
    writeup: bool('Copy-ready writeup (Markdown)', false, {
      hint: 'Add a Markdown "how I found it" report you can paste into a CTF writeup.',
    }),
  },
  examples: [
    {
      label: 'Text hidden in a bit plane (blue bit 0)',
      input: { sample: 'image-lab-bit0-text.png' },
      expect: 'B0 · blue bit 0 (lowest): Blue bit 0 (lowest):',
    },
    {
      label: 'Colours that differ by one level',
      input: { sample: 'image-lab-near-bg.png' },
      expect: 'Value step',
    },
    {
      label: 'Cropped by a falsified height',
      input: { sample: 'image-lab-ihdr.png' },
      expect: 'repaired.png',
    },
    {
      label: 'Metadata, text chunk, LSB message and appended ZIP',
      input: { sample: 'image-lab-loaded.png' },
      expect: 'FTF{lab_lsb_b1_rgb}',
    },
    {
      label: 'A clean picture: nothing stands out',
      input: { sample: 'image-lab-clean.png' },
      expect: 'Nothing stands out',
    },
  ],
  async run(input, o) {
    const { bytes, image } = input;
    if (!bytes.length) throw new ToolError(T('error.empty'));
    const side = Math.min(2000, Math.max(200, Math.round(o.maxSide) || DEFAULT_SIDE));
    const min = Math.min(200, Math.max(3, Math.round(o.minLength) || 8));

    // A broken IHDR (a falsified height) decodes as a cropped picture: analyse the repaired one.
    const structure = await structureOutputs(input);
    const base = structure.repaired ?? image;
    const { image: work, scaled } = fitImage(base, side);
    const visuals = buildVisuals(work);

    const notes: Output[] = [{ type: 'note', level: 'success', text: T('note.privacy') }];
    if (structure.repaired) {
      notes.push({
        type: 'note',
        level: 'warn',
        text: T('note.analysingRepaired', {
          from: `${image.width}×${image.height}`,
          to: `${base.width}×${base.height}`,
        }),
      });
    }
    if (scaled) {
      notes.push({
        type: 'note',
        level: 'info',
        text: T('note.downsampled', {
          from: `${base.width}×${base.height}`,
          to: `${work.width}×${work.height}`,
        }),
      });
    }

    const groups = [...visuals.groups];
    const lookFirst = [...visuals.lookFirst];
    const reasons = [...visuals.reasons];
    if (structure.repaired) {
      const repaired: GalleryItem = {
        id: 'repaired',
        label: T('label.repairedImage'),
        image: fitPixels(structure.repaired, work.width * work.height),
        note: T('note.repairedItem'),
        suspect: true,
      };
      groups.unshift({ title: T('group.repair'), items: [repaired] });
      lookFirst.unshift(repaired.id);
      reasons.unshift([repaired.label, T('note.repairedItem')]);
    }

    const triage: Output[] = reasons.length
      ? [
          {
            type: 'kv',
            label: T('label.lookFirst'),
            entries: reasons,
          },
          { type: 'note', level: 'info', text: T('lesson.triage') },
        ]
      : [{ type: 'note', level: 'info', text: T('note.clean', { planes: visuals.scored }) }];

    const lsb = lsbOutputs(base, o.showAll);
    const strings = stringsOutputs(bytes, min, o.showAll);
    const out: Output[] = [
      ...notes,
      ...triage,
      { type: 'gallery', label: T('label.gallery'), groups, lookFirst },
      ...infoOutputs(input, scaled ? { w: work.width, h: work.height } : null),
      ...(await analyzerOutputs(input)),
      ...structure.out,
      ...lsb.out,
      ...strings.out,
      ...passwordOutputs(bytes, input.name, strings.found),
    ];
    if (o.writeup) out.push(writeup(reasons, lsb.best));
    return out;
  },
});

/** The Markdown "how I found it": what the triage flagged and what the LSB scan read. */
function writeup(reasons: [string, string][], best: string | null): Output {
  const sections: WriteupSection[] = [];
  if (reasons.length) {
    sections.push({
      heading: T('label.lookFirst'),
      body: mdTable([T('col.picture'), T('col.why')], reasons),
    });
  }
  if (best) sections.push({ heading: T('label.lsb'), body: best });
  sections.push({ heading: T('writeup.technique'), body: T('lesson.triage') });
  return {
    type: 'text',
    label: T('label.writeup'),
    value: buildWriteup(sections, { title: T('writeup.title') }),
  };
}
