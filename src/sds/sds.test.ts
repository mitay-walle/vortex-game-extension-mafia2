import { describe, expect, it } from 'vitest';
import { mergeSds } from './merge';
import { fnv32, readSds, writeSds } from './sds';
import { archive, resource, rowsOf } from './test-fixtures';

describe('SDS writer', () => {
  it('round-trips through the reader, with valid header checksums', () => {
    // more than one 0x4000 block, partly incompressible
    const big = Buffer.concat([Buffer.alloc(0x5000, 7), Buffer.from(Array.from({ length: 0x3000 }, (_, i) => (i * 7919) % 251))]);
    const original = { ...archive([[1, 10]]), resources: [...archive([[1, 10]]).resources, resource(1, 'XML', big)] };
    const file = writeSds(original);
    expect(file.readUInt32LE(12)).toBe(fnv32(file.subarray(0, 12)));
    expect(file.readUInt32LE(68)).toBe(fnv32(file.subarray(16, 68)));
    const back = readSds(file);
    expect(back.resources.map(r => r.data)).toEqual(original.resources.map(r => r.data));
    expect(back.resourceInfoXml).toBe(original.resourceInfoXml);
    expect(back.unknown20).toEqual(original.unknown20);
  });
});

describe('mergeSds', () => {
  const vanilla = archive([[1, 10], [2, 20], [3, 30]]);

  it('takes rows from different mods', () => {
    const { archive: out, conflicts } = mergeSds(vanilla, [
      { label: 'a', archive: archive([[1, 11], [2, 20], [3, 30]]) },
      { label: 'b', archive: archive([[1, 10], [2, 20], [3, 33]]) },
    ]);
    expect(rowsOf(out)).toEqual([[1, 11], [2, 20], [3, 33]]);
    expect(conflicts).toEqual([]);
  });

  it('lets the later mod win a row both changed, and reports it', () => {
    const { archive: out, conflicts } = mergeSds(vanilla, [
      { label: 'a', archive: archive([[1, 11], [2, 20], [3, 30]]) },
      { label: 'b', archive: archive([[1, 12], [2, 20], [3, 30]]) },
    ]);
    expect(rowsOf(out)[0]).toEqual([1, 12]);
    expect(conflicts).toEqual([{
      id: 'table /tables/weapons.tbl id 1', mods: ['a', 'b'], used: 'b', picked: false, perField: true,
      fields: [{
        id: 'table /tables/weapons.tbl id 1 #1', column: '#1 bbbbbbbb', type: 3, vanilla: '10',
        values: { a: '11', b: '12' }, mods: ['a', 'b'], used: 'b', picked: false,
      }],
    }]);
  });

  it('merges a row field by field: different fields from different mods, no conflict', () => {
    const base = archive([[1, 10, 100], [2, 20, 200]]);
    const { archive: out, conflicts } = mergeSds(base, [
      { label: 'a', archive: archive([[1, 11, 100], [2, 20, 200]]) },
      { label: 'b', archive: archive([[1, 10, 111], [2, 20, 200]]) },
    ]);
    expect(rowsOf(out)).toEqual([[1, 11, 111], [2, 20, 200]]);
    expect(conflicts).toEqual([]);
  });

  it('reports only the contested fields, a field pick beats a row pick', () => {
    const base = archive([[1, 10, 100, 1000]]);
    const mods = [
      { label: 'a', archive: archive([[1, 11, 101, 1000]]) },
      { label: 'b', archive: archive([[1, 12, 102, 1002]]) },
    ];
    const row = 'table /tables/weapons.tbl id 1';
    const auto = mergeSds(base, mods);
    expect(rowsOf(auto.archive)).toEqual([[1, 12, 102, 1002]]);
    expect(auto.conflicts[0]!.fields!.map(f => f.id)).toEqual([`${row} #1`, `${row} #2`]);
    const picked = mergeSds(base, mods, new Map([[row, 'a'], [`${row} #2`, 'b']]));
    expect(rowsOf(picked.archive)).toEqual([[1, 11, 102, 1002]]);
    expect(picked.conflicts[0]!.fields!.map(f => [f.used, f.picked])).toEqual([['a', true], ['b', true]]);
  });

  it('uses the mod the user picked for a conflict, other rows still merge', () => {
    const mods = [
      { label: 'a', archive: archive([[1, 11], [2, 22], [3, 30]]) },
      { label: 'b', archive: archive([[1, 12], [2, 20], [3, 33]]) },
    ];
    const { archive: out, conflicts } = mergeSds(vanilla, mods, new Map([['table /tables/weapons.tbl id 1', 'a']]));
    expect(rowsOf(out)).toEqual([[1, 11], [2, 22], [3, 33]]);
    expect(conflicts).toMatchObject([{ id: 'table /tables/weapons.tbl id 1', mods: ['a', 'b'], used: 'a', picked: true }]);
  });

  it('ignores a pick of a mod that no longer changes that row', () => {
    const mods = [
      { label: 'a', archive: archive([[1, 11], [2, 20], [3, 30]]) },
      { label: 'b', archive: archive([[1, 12], [2, 20], [3, 30]]) },
    ];
    const { archive: out } = mergeSds(vanilla, mods, new Map([['table /tables/weapons.tbl id 1', 'gone']]));
    expect(rowsOf(out)[0]).toEqual([1, 12]);
  });

  it('picks work for whole resources too', () => {
    const mods = [
      { label: 'a', archive: archive([[1, 10], [2, 20], [3, 30]], 'value\x01two') },
      { label: 'b', archive: archive([[1, 10], [2, 20], [3, 30]], 'value\x01three') },
    ];
    const { archive: out, conflicts } = mergeSds(vanilla, mods, new Map([['XML /config/x', 'a']]));
    expect(out.resources[1]!.data.toString('latin1')).toContain('two');
    expect(conflicts.map(c => [c.id, c.used])).toEqual([['XML /config/x', 'a']]);
  });

  it('appends new rows and grows the RAM figures by the size change', () => {
    const { archive: out } = mergeSds(vanilla, [{ label: 'a', archive: archive([[1, 10], [2, 20], [3, 30], [4, 40]]) }]);
    expect(rowsOf(out)).toEqual([[1, 10], [2, 20], [3, 30], [4, 40]]);
    expect(out.resources[0]!.slotRamRequired).toBe(vanilla.resources[0]!.slotRamRequired + 8);
    expect(out.slotRamRequired).toBe(vanilla.slotRamRequired + 8);
  });

  it('ignores an XML resource whose strings match vanilla (re-saved by a tool), takes a real edit', () => {
    const resaved = archive([[1, 10], [2, 20], [3, 30]], 'value\x02one');
    expect(mergeSds(vanilla, [{ label: 'a', archive: resaved }]).changes).toEqual([]);
    const edited = archive([[1, 10], [2, 20], [3, 30]], 'value\x01two');
    expect(mergeSds(vanilla, [{ label: 'a', archive: edited }]).archive.resources[1]!.data).toEqual(edited.resources[1]!.data);
  });
});
