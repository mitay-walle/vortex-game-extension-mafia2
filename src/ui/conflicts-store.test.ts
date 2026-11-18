import { describe, expect, it } from 'vitest';

import type { MergeConflict } from '../sds/merge';
import { conflictLines, fieldChoice, pickAll, pickField, pickRow, resetFile, rowChoice } from './conflicts-store';

const F = 'pc/sds/tables/tables.sds';
const ROW = 'table /tables/weapons.tbl id 11';
const field = (i: number, mods: string[]) => ({
  id: `${ROW} #${i}`, column: `#${i} 00000000`, type: 3, vanilla: '0', values: {}, mods, used: mods.at(-1)!, picked: false,
});
const perField: MergeConflict = {
  id: ROW, mods: ['A', 'B'], used: 'B', picked: false, perField: true, fields: [field(5, ['A', 'B']), field(6, ['A', 'B'])],
};
const whole: MergeConflict = { id: 'XML /config/x', mods: ['A', 'B', 'C'], used: 'C', picked: false };

describe('conflict choices', () => {
  it('defaults to the later mod', () => {
    expect(rowChoice({}, F, perField)).toBe('B');
    expect(rowChoice({}, F, whole)).toBe('C');
  });

  it('a field pick splits the row, a row pick joins it again', () => {
    let c = pickField({}, F, `${ROW} #5`, 'A');
    expect(fieldChoice(c, F, ROW, perField.fields![0]!)).toBe('A');
    expect(rowChoice(c, F, perField)).toBeUndefined();
    c = pickRow(c, F, perField, 'B');
    expect(c[F]).toEqual({ [ROW]: 'B' });
    expect(rowChoice(c, F, perField)).toBe('B');
  });

  it('"all from" picks the mod where it takes part, reset clears the file', () => {
    const c = pickAll({}, F, [perField, whole], 'C');
    expect(c[F]).toEqual({ 'XML /config/x': 'C' });
    expect(resetFile(c, F)[F]).toEqual({});
  });

  it('ignores a saved pick of a mod that no longer takes part', () => {
    expect(rowChoice({ [F]: { [ROW]: 'gone' } }, F, perField)).toBe('B');
  });
});

describe('conflictLines', () => {
  it('one line per contested field, the row named on the first; whole resources get one line', () => {
    const lines = conflictLines({}, F, [perField, whole]);
    expect(lines.map(l => [l.place, l.field, l.chosen])).toEqual([
      ['weapons 11', '#5', 'B'], ['', '#6', 'B'], ['XML x', '', 'C'],
    ]);
    expect(lines[0]!.pick({}, 'A')[F]).toEqual({ [`${ROW} #5`]: 'A' });
  });
});

describe('conflictLines names', () => {
  it('uses the row name and known column names', () => {
    const named = { ...perField, name: 'Thompson 1928' };
    const lines = conflictLines({}, F, [named], { '00000000': 'BulletsWeapon' });
    expect(lines.map(l => [l.place, l.table, l.field])).toEqual([
      ['Thompson 1928', 'weapons 11', 'BulletsWeapon'], ['', '', 'BulletsWeapon'],
    ]);
  });
});
