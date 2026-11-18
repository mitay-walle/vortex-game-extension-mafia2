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
    expect(conflicts).toEqual(['table /tables/weapons.tbl id 1: changed by a and b, using b']);
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
