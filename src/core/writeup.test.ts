import { describe, expect, it } from 'vitest';
import { buildWriteup, codeBlock, kvTable, mdTable } from './writeup';

const sections = [
  { heading: 'How', body: 'Found with serpentine order.' },
  { heading: 'Proof', body: 'x' },
];

describe('buildWriteup', () => {
  it('renders the title and each section as a level-2 heading', () => {
    const md = buildWriteup(sections, { title: 'Writeup' });
    expect(md).toBe('# Writeup\n\n## How\n\nFound with serpentine order.\n\n## Proof\n\nx\n');
  });

  it('is deterministic and ends with a single newline', () => {
    expect(buildWriteup(sections)).toBe(buildWriteup(sections));
    expect(buildWriteup(sections).endsWith('x\n')).toBe(true);
  });

  it('adds the flag only when opted in and present', () => {
    const flag = 'FTF{secret}';
    expect(buildWriteup(sections, { flag })).not.toContain(flag);
    expect(buildWriteup(sections, { flag, includeFlag: false })).not.toContain(flag);
    expect(buildWriteup(sections, { includeFlag: true })).not.toContain('Flag');
    const md = buildWriteup(sections, { flag, includeFlag: true, flagLabel: 'Drapeau' });
    expect(md).toContain('**Drapeau:** `FTF{secret}`');
  });

  it('masks the flag inside section bodies unless opted in', () => {
    const body = [{ heading: 'Decoded', body: 'got FTF{secret} here' }];
    const flag = 'FTF{secret}';
    expect(buildWriteup(body, { flag })).toContain('got <flag> here');
    expect(buildWriteup(body, { flag })).not.toContain(flag);
    expect(buildWriteup(body, { flag, includeFlag: true })).toContain('got FTF{secret} here');
  });

  it('keeps a heading with an empty body well-formed', () => {
    expect(buildWriteup([{ heading: 'Only', body: '  ' }])).toBe('## Only\n');
  });
});

describe('kvTable', () => {
  it('renders a header, a separator and escaped rows', () => {
    const md = kvTable(
      [
        ['a|b', '1'],
        ['c', 'x\ny'],
      ],
      ['Key', 'Value'],
    );
    expect(md.split('\n')).toEqual([
      '| Key | Value |',
      '| --- | --- |',
      '| a\\|b | 1 |',
      '| c | x y |',
    ]);
  });

  it('returns an empty string for no entries', () => {
    expect(kvTable([])).toBe('');
  });
});

describe('mdTable', () => {
  it('renders any width and pads short rows', () => {
    expect(mdTable(['a', 'b', 'c'], [[1, 'x']]).split('\n')).toEqual([
      '| a | b | c |',
      '| --- | --- | --- |',
      '| 1 | x |  |',
    ]);
  });

  it('returns an empty string without rows', () => {
    expect(mdTable(['a'], [])).toBe('');
  });
});

describe('codeBlock', () => {
  it('fences the text with a language', () => {
    expect(codeBlock('py', 'print(1)\n')).toBe('```py\nprint(1)\n```');
  });

  it('uses a longer fence when the text contains backticks', () => {
    expect(codeBlock('', 'a ``` b')).toBe('````\na ``` b\n````');
  });
});
