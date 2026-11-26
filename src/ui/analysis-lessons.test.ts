import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { analyze, type AnalysisResult, type Finding } from '../core/analyze';
import { getTool, TOOLS } from '../core/registry';
import { resultToText } from '../core/result-text';
import { setLocale } from '../i18n';
import {
  analysisWriteup,
  canonicalKind,
  checkLabel,
  isLimit,
  redoFor,
  strongest,
  verdictOf,
  verdictText,
} from './analysis-lessons';

const sample = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, '../../public/samples', name)));

const finding = (kind: string, confidence: Finding['confidence'], extra: Partial<Finding> = {}) =>
  ({ kind, confidence, title: kind, ...extra }) satisfies Finding;
const result = (findings: Finding[], checklist: string[] = []): AnalysisResult => ({
  findings,
  checklist,
});

beforeAll(() => setLocale('en'));
afterEach(() => setLocale('en'));

describe('the hidden analyze tool', () => {
  it('runs through the registry but stays out of the catalog', async () => {
    const tool = getTool('analyze');
    expect(tool?.hidden).toBe(true);
    expect(TOOLS.some((t) => t.id === 'analyze')).toBe(false);
    const out = await tool!.run(
      { bytes: sample('extract-nested.zip'), name: 'x.zip' } as never,
      {},
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('analysis');
    expect(resultToText(out)).toContain('FTF{extract_unwraps_layers}');
  });
});

describe('verdict', () => {
  it('is one sentence from the strongest finding', async () => {
    const r = await analyze(sample('mp4-encrypted-mdat.mp4'), 'v.mp4');
    const v = verdictOf(r);
    expect(v.key).toBe('ui.analysis.verdict.encrypted');
    expect(verdictText(r)).toMatch(/MiB of what looks like encrypted data is hidden/);
  });

  it('names a recovered flag', async () => {
    const r = await analyze(sample('stego-lsb.png'), 'p.png');
    expect(verdictText(r)).toContain('flag{lsb_hidden_in_pixels}');
  });

  it('says so when nothing was found', async () => {
    const r = await analyze(sample('clean-photo.jpg'), 'c.jpg');
    expect(r.findings.filter((f) => f.confidence !== 'candidate')).toEqual([]);
    expect(verdictOf(result([])).key).toBe('ui.analysis.verdict.none');
  });

  it('prefers a stronger tier, then a more telling kind', () => {
    const r = result([
      finding('gap', 'candidate'),
      finding('post-eof', 'probable'),
      finding('encrypted', 'probable'),
      finding('container', 'confirmed'),
    ]);
    expect(strongest(r)?.kind).toBe('container');
    expect(strongest(result(r.findings.slice(0, 3)))?.kind).toBe('encrypted');
  });
});

describe('lessons and redo', () => {
  const kinds = [
    'flag',
    'encrypted',
    'post-eof',
    'gap',
    'high-entropy',
    'container',
    'carved',
    'embedded',
    'decoded',
    'symbol-words',
    'cipher-hint',
    'stego-lsb',
    'stego-lsb-zone',
    'stego-pvd',
    'stego-pit',
    'stego-statistics',
    'stego-audio-lsb',
    'stego-x86-encoding',
    'stego-emd',
    'something-new',
  ];

  it('has a lesson and a label in every language for every kind', () => {
    for (const locale of ['en', 'fr', 'ru', 'zh', 'hi']) {
      const dict = JSON.parse(
        readFileSync(join(__dirname, `../i18n/locales/${locale}.json`), 'utf8'),
      ) as Record<string, string>;
      for (const kind of kinds) {
        const c = canonicalKind(kind);
        expect(dict[`ui.analysis.lesson.${c}`], `${locale} lesson ${c}`).toBeTruthy();
        expect(dict[`ui.analysis.kind.${c}`], `${locale} kind ${c}`).toBeTruthy();
      }
    }
  });

  it('points every kind at tools that exist', () => {
    for (const kind of kinds) {
      const redo = redoFor(finding(kind, 'probable', { offset: 100, size: 600 }));
      expect(redo.open.length + redo.commands.length, kind).toBeGreaterThan(0);
      for (const target of redo.open)
        expect(getTool(target.tool), `${kind} -> ${target.tool}`).toBeDefined();
    }
  });

  it('seeds the hex dump with the region and quotes the file name', () => {
    const redo = redoFor(finding('post-eof', 'probable', { offset: 754, size: 40 }), {
      bytes: new Uint8Array(1),
      name: "it's.png",
      raw: {},
    });
    expect(redo.open[0]).toEqual({ tool: 'hexdump', options: { start: '754', length: '40' } });
    expect(redo.commands[0]).toBe(`tail -c +755 'it'\\''s.png' > tail.bin && file tail.bin`);
  });

  it('routes a flag to the tool that found it', () => {
    expect(
      redoFor(finding('flag', 'confirmed', { detail: 'lsb:rgb/0/row/msb', flag: 'f' })).open[0]
        ?.tool,
    ).toBe('lsb');
    expect(
      redoFor(finding('flag', 'confirmed', { detail: 'pvd:table/x', flag: 'f' })).open[0]?.tool,
    ).toBe('pvd');
  });
});

describe('checklist and writeup', () => {
  it('separates what was done from what was skipped or failed', () => {
    expect(isLimit('anomaly-scan-skipped:too-large')).toBe(true);
    expect(isLimit('detector-failed:image')).toBe(true);
    expect(isLimit('extraction-truncated')).toBe(true);
    expect(isLimit('detector-run:image')).toBe(false);
    expect(isLimit('structure-parsed')).toBe(false);
  });

  it('turns codes into words', () => {
    expect(checkLabel('format-identified:png')).toBe('File format identified: png');
    expect(checkLabel('detector-run:image')).toBe('Detector run: image steganography');
    expect(checkLabel('anomaly-scan-skipped:too-large')).toContain('too large');
    expect(checkLabel('mystery-code')).toBe('mystery-code');
  });

  it('leaves the flag out of the writeup unless asked', async () => {
    const bytes = sample('stego-lsb.png');
    const r = await analyze(bytes, 'p.png');
    const source = { bytes, name: 'p.png', raw: { bytes } };
    const hidden = analysisWriteup({ result: r, source, includeFlag: false });
    expect(hidden).not.toContain('flag{lsb_hidden_in_pixels}');
    expect(hidden).toContain('<flag>');
    const shown = analysisWriteup({ result: r, source, includeFlag: true });
    expect(shown).toContain('flag{lsb_hidden_in_pixels}');
    expect(shown).toContain('# Analysis of p.png');
    expect(shown).toContain('## What was checked');
  });
});
