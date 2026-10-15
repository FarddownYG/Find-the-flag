/** The Strings view: strings per section, flag-like ones first. */
import type { Output } from '../../core/types';
import { toolT } from '../../i18n/tool-text';
import { hex } from './_exe-bin';
import type { StringsResult } from './_exe-strings';
import { toolLabel, type Opts } from './_exe-view';

const T = toolT('exe-analyzer');

export function stringsOutputs(res: StringsResult, o: Opts, regions: number): Output[] {
  const out: Output[] = [];
  if (res.rows.length === 0) {
    out.push({
      type: 'note',
      level: 'info',
      text: o.filter.trim() ? T('note.noStringsMatch') : T('note.noStrings', { min: o.min }),
    });
    return out;
  }
  const flagged = res.rows.filter((r) => r.flag).length;
  out.push({
    type: 'table',
    label: flagged
      ? T('label.stringsFlagged', { count: res.rows.length, flagged, regions })
      : T('label.strings', { count: res.rows.length, regions }),
    columns: [T('col.section'), T('col.offset'), T('col.encoding'), T('col.string')],
    rows: res.rows.map((r) => [r.region, hex(r.offset), r.encoding, r.text]),
    highlight: res.rows.flatMap((r, i) => (r.flag ? [i] : [])),
  });
  if (res.droppedRows > 0) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.stringsCapped', {
        shown: res.rows.length,
        total: res.rows.length + res.droppedRows,
      }),
    });
  }
  if (res.cutRegions.length > 0) {
    out.push({
      type: 'note',
      level: 'warn',
      text: T('note.regionsCut', { names: res.cutRegions.join(', ') }),
    });
  }
  out.push({
    type: 'note',
    level: 'info',
    text: T('hint.strings', { strings: toolLabel('strings'), hexdump: toolLabel('hexdump') }),
  });
  return out;
}
