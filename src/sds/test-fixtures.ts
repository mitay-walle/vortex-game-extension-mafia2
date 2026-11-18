import type { SdsArchive, SdsResource } from './sds';

// Small synthetic SDS archives for tests: one table (id, value) and one XML resource.
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const str32 = (s: string) => Buffer.concat([u32(s.length), Buffer.from(s, 'latin1')]);

/** One table, two u32 columns (id, value), rows given as [id, value]. */
function tableResource(name: string, rows: [number, number][]): Buffer {
  return Buffer.concat([
    u32(1),
    Buffer.alloc(8), u16(name.length), Buffer.from(name, 'latin1'), u16(2), u32(0), u32(0),
    u32(8), u32(rows.length), ...rows.map(([id, v]) => Buffer.concat([u32(id), u32(v)])),
    Buffer.from('aaaaaaaa0300000bbbbbbbbb03000000', 'hex'),
  ]);
}

const xmlResource = (name: string, body: string) =>
  Buffer.concat([str32('UnknownTargetSystem'), Buffer.from([0]), str32(`${name}\0`), Buffer.from(body, 'latin1')]);

export function resource(typeId: number, typeName: string, data: Buffer): SdsResource {
  return { typeId, typeName, version: 1, slotRamRequired: data.length, slotVramRequired: 0, otherRamRequired: 0, otherVramRequired: 0, data };
}

export function archive(rows: [number, number][], xmlBody = 'value\x01one'): SdsArchive {
  const resources = [
    resource(0, 'Table', tableResource('/tables/weapons.tbl', rows)),
    resource(1, 'XML', xmlResource('/config/x', xmlBody)),
  ];
  return {
    platform: 'PC',
    slotRamRequired: resources.reduce((s, r) => s + r.slotRamRequired, 0),
    slotVramRequired: 0, otherRamRequired: 0, otherVramRequired: 0, flags: 1,
    unknown20: Buffer.from('73979+\0\0\0\0\0\0\0\0\0\0', 'latin1'),
    resourceTypes: [{ id: 0, name: 'Table', parent: 0 }, { id: 1, name: 'XML', parent: 0 }],
    resources,
    resourceInfoXml: '<?xml version="1.0"?>\r\n<xml>\r\n</xml>\r\n',
  };
}

export const rowsOf = (a: SdsArchive) => {
  const d = a.resources[0]!.data;
  const nameLength = d.readUInt16LE(12);
  const at = 14 + nameLength + 10;
  const count = d.readUInt32LE(at + 4);
  return Array.from({ length: count }, (_, i) => [d.readUInt32LE(at + 8 + i * 8), d.readUInt32LE(at + 12 + i * 8)]);
};

