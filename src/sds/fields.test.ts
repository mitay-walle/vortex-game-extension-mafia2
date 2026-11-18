import { describe, expect, it } from 'vitest';
import { diffFields, fnv1, formatField, hashHex, KNOWN_COLUMNS, parseColumnNames, readColumns, rowName } from './fields';

const columns = (...types: number[]) => Buffer.concat(types.map((type, i) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0x1000 + i);
  b[4] = type;
  return b;
}));

describe('readColumns', () => {
  it('lays out columns by type size (MaterialsPhysics.tbl: 32,6,2,2,2,64 = 116 bytes)', () => {
    const cols = readColumns(columns(32, 6, 2, 2, 2, 64), 116)!;
    expect(cols.map(c => [c.offset, c.size])).toEqual([[0, 32], [32, 8], [40, 4], [44, 4], [48, 4], [52, 64]]);
  });

  it('gives one column of an unknown type the rest of the row', () => {
    expect(readColumns(columns(3, 99, 3), 20)!.map(c => c.size)).toEqual([4, 12, 4]);
  });

  it('refuses a layout that does not add up', () => {
    expect(readColumns(columns(3, 3), 12)).toBeUndefined();
    expect(readColumns(columns(98, 99), 12)).toBeUndefined();
  });
});

describe('fields', () => {
  const cols = columns(3, 2, 32);
  const row = (id: number, f: number, text: string) => {
    const b = Buffer.alloc(40);
    b.writeInt32LE(id, 0);
    b.writeFloatLE(f, 4);
    b.write(text, 8, 'latin1');
    return b;
  };

  it('formats ints, floats and text', () => {
    const layout = readColumns(cols, 40)!;
    const r = row(7, 1.25, 'colt');
    expect(layout.map(c => formatField(r, c))).toEqual(['7', '1.25', '"colt"']);
  });

  it('lists only the fields some version changed', () => {
    const diffs = diffFields(cols, 40, row(1, 1.5, 'gun'), [
      { label: 'a', data: row(1, 2.5, 'gun') },
      { label: 'b', data: row(1, 1.5, 'big gun') },
    ]);
    expect(diffs).toEqual([
      { column: '#1 00001001', type: 2, vanilla: '1.5', values: { a: '2.5', b: '1.5' } },
      { column: '#2 00001002', type: 32, vanilla: '"gun"', values: { a: '"gun"', b: '"big gun"' } },
    ]);
  });
});

describe('column names', () => {
  it('hashes names as the game does (FNV-1 32), known ones match the vanilla columns', () => {
    expect(hashHex(fnv1('BulletsWeapon'))).toBe('5d67ac10'); // weapons.tbl #6
    expect(KNOWN_COLUMNS['f3a06094']).toBe('Reaction'); // police_offences.tbl #4
    expect(KNOWN_COLUMNS['4876ee26']).toBe('ID');
  });

  it('reads plain name lists and "<decimal hash> <name>" lists', () => {
    expect(parseColumnNames('BulletsWeapon\r\n\r\n123 Custom\n')).toEqual({ '5d67ac10': 'BulletsWeapon', '0000007b': 'Custom' });
  });

  it('names a row by its first text column', () => {
    const row = Buffer.alloc(40);
    row.writeInt32LE(11, 0);
    row.write('Thompson 1928', 8, 'latin1');
    expect(rowName(columns(3, 2, 32), 40, row)).toBe('Thompson 1928');
    expect(rowName(columns(3, 3), 8, Buffer.alloc(8))).toBeUndefined();
  });
});
