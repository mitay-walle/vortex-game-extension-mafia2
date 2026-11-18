// Reader and writer for Illusion Engine SDS archives, version 19 (Mafia II), PC only.
//
// Layout and field names follow Gibbed.Mafia2.FileFormats / Gibbed.Illusion.FileFormats
// (https://github.com/gibbed/Gibbed.Illusion), Copyright (c) 2017 Rick (rick 'at' gibbed 'dot' us),
// zlib License. This is an altered, independent TypeScript re-implementation, not the original.
import { deflateSync, inflateSync } from 'node:zlib';

export interface SdsResourceType {
  id: number;
  name: string;
  parent: number;
}

export interface SdsResource {
  typeId: number;
  typeName: string;
  version: number;
  slotRamRequired: number;
  slotVramRequired: number;
  otherRamRequired: number;
  otherVramRequired: number;
  data: Buffer;
}

export interface SdsArchive {
  platform: string;
  slotRamRequired: number;
  slotVramRequired: number;
  otherRamRequired: number;
  otherVramRequired: number;
  flags: number;
  unknown20: Buffer;
  resourceTypes: SdsResourceType[];
  resources: SdsResource[];
  /** The trailing XML, one <ResourceInfo> per resource in archive order (names, source paths). */
  resourceInfoXml: string;
}

const SIGNATURE = 0x53445300; // 'SDS\0', big endian
const BLOCK_SIGNATURE = 0x6c7a4555; // 'UEzl' read little endian
const RESOURCE_HEADER_SIZE_IN_SIZE = 30; // 26-byte header + 4-byte checksum

const BLOCK_ALIGNMENT = 0x4000;
const BLOCK_FLAGS = 4;
// constants of every compressed block header in retail archives (Unknown04/08/0C in Gibbed)
const COMPRESSED_BLOCK_CONSTANTS = [32, 81920, 135200769];

/** FNV-1 32-bit (multiply, then xor), as Gibbed.Illusion.FileFormats.Hashing.FNV32. */
export function fnv32(data: Buffer): number {
  let hash = 0x811c9dc5;
  for (const byte of data) hash = (Math.imul(hash, 0x1000193) ^ byte) >>> 0;
  return hash;
}

class Cursor {
  readonly buf: Buffer;
  pos: number;
  constructor(buf: Buffer, pos = 0) { this.buf = buf; this.pos = pos; }
  u8(): number { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  u16(): number { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32(): number { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  bytes(n: number): Buffer { const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  stringU32(): string { const n = this.u32(); return this.bytes(n).toString('latin1'); }
}

/** Concatenates the block stream (compressed and stored blocks) into one buffer. */
function readBlockStream(c: Cursor): Buffer {
  if (c.u32() !== BLOCK_SIGNATURE) throw new Error('SDS: bad block stream signature');
  c.u32(); // alignment, 0x4000
  if (c.u8() !== 4) throw new Error('SDS: unexpected block stream flags');
  const parts: Buffer[] = [];
  for (;;) {
    const size = c.u32();
    const compressed = c.u8() !== 0;
    if (size === 0) break;
    if (compressed) {
      const uncompressedSize = c.u32();
      c.pos += 12; // unknown04, unknown08, unknown0C
      const compressedSize = c.u32();
      c.pos += 12; // unknown14, unknown18, unknown1C
      if (size - 32 !== compressedSize) throw new Error('SDS: compressed block size mismatch');
      const out = inflateSync(c.bytes(compressedSize));
      if (out.length !== uncompressedSize) throw new Error('SDS: inflated block size mismatch');
      parts.push(out);
    } else {
      parts.push(c.bytes(size));
    }
  }
  return Buffer.concat(parts);
}

// Retail tables.sds is a decoy archive holding one `tables/fsfh.bin`; the real archive follows at
// 0x10000, TEA-encrypted (Gibbed.Mafia2.FileFormats/ArchiveEncryption.cs).
const TEA_KEYS = [0x73766e46, 0x6d454d5a, 0x336a6d68, 0x38425072];
const TEA_SETTINGS = [
  { sum: 0x79fb0b01, delta: 0x4b989bcd, rounds: 5 },
  { sum: 0xa62336c0, delta: 0x9d3119b6, rounds: 32 },
];
const WRAPPED_MARKER = 'tables/fsfh.bin';
const WRAPPED_OFFSET = 0x10000;

function teaDecrypt(data: Buffer, sum0: number, delta: number, rounds: number): void {
  const [k0, k1, k2, k3] = TEA_KEYS as [number, number, number, number];
  for (let i = 0; i + 8 <= data.length; i += 8) {
    let v0 = data.readUInt32LE(i);
    let v1 = data.readUInt32LE(i + 4);
    let sum = sum0;
    for (let r = 0; r < rounds; r++) {
      v1 = (v1 - ((((v0 << 4) + k2) ^ (v0 + sum) ^ ((v0 >>> 5) + k3)) >>> 0)) >>> 0;
      v0 = (v0 - ((((v1 << 4) + k0) ^ (v1 + sum) ^ ((v1 >>> 5) + k1)) >>> 0)) >>> 0;
      sum = (sum - delta) >>> 0;
    }
    data.writeUInt32LE(v0, i);
    data.writeUInt32LE(v1, i + 4);
  }
}

/** Returns the decrypted inner archive of a wrapped (encrypted) SDS, or undefined if it isn't one. */
export function unwrapSds(file: Buffer): Buffer | undefined {
  if (file.length < WRAPPED_OFFSET + 16) return undefined;
  if (file.subarray(0x90, 0x90 + WRAPPED_MARKER.length).toString('latin1') !== WRAPPED_MARKER) return undefined;
  for (const { sum, delta, rounds } of TEA_SETTINGS) {
    const probe = Buffer.from(file.subarray(WRAPPED_OFFSET, WRAPPED_OFFSET + 16));
    teaDecrypt(probe, sum, delta, rounds);
    if (probe.readUInt32BE(0) !== SIGNATURE) continue;
    const out = Buffer.from(file.subarray(WRAPPED_OFFSET));
    // decrypted in 0x4000-byte chunks, so a tail shorter than 8 bytes in each chunk stays as is
    for (let o = 0; o < out.length; o += 0x4000) teaDecrypt(out.subarray(o, Math.min(o + 0x4000, out.length)), sum, delta, rounds);
    return out;
  }
  return undefined;
}

export function readSds(input: Buffer): SdsArchive {
  const file = unwrapSds(input) ?? input;
  if (file.readUInt32BE(0) !== SIGNATURE) throw new Error('SDS: not an SDS file (or encrypted)');
  const version = file.readUInt32LE(4);
  if (version !== 19) throw new Error(`SDS: unsupported version ${version}`);
  const platform = file.subarray(8, 12).toString('latin1').replace(/\0/g, '');
  if (platform !== 'PC') throw new Error(`SDS: unsupported platform ${platform}`);

  // 12: FNV32 of the first 12 bytes (Steam build), then the 52-byte file header, then its FNV32
  const c = new Cursor(file, 16);
  const resourceTypeTableOffset = c.u32();
  const blockTableOffset = c.u32();
  const xmlOffset = c.u32();
  const slotRamRequired = c.u32();
  const slotVramRequired = c.u32();
  const otherRamRequired = c.u32();
  const otherVramRequired = c.u32();
  const flags = c.u32();
  const unknown20 = Buffer.from(c.bytes(16));
  const resourceCount = c.u32();

  c.pos = resourceTypeTableOffset;
  const resourceTypes: SdsResourceType[] = [];
  for (let i = c.u32(); i > 0; i--) {
    resourceTypes.push({ id: c.u32(), name: c.stringU32(), parent: c.u32() });
  }
  const typeName = new Map(resourceTypes.map(t => [t.id, t.name]));

  c.pos = blockTableOffset;
  const stream = new Cursor(readBlockStream(c));
  const resources: SdsResource[] = [];
  for (let i = 0; i < resourceCount; i++) {
    const typeId = stream.u32();
    const size = stream.u32();
    const version = stream.u16();
    const header = {
      slotRamRequired: stream.u32(),
      slotVramRequired: stream.u32(),
      otherRamRequired: stream.u32(),
      otherVramRequired: stream.u32(),
    };
    stream.u32(); // FNV32 checksum of the header (Steam build), counted in the 30 bytes
    if (size < RESOURCE_HEADER_SIZE_IN_SIZE) throw new Error('SDS: bad resource size');
    resources.push({
      typeId,
      typeName: typeName.get(typeId) ?? `#${typeId}`,
      version,
      ...header,
      data: Buffer.from(stream.bytes(size - RESOURCE_HEADER_SIZE_IN_SIZE)),
    });
  }

  return {
    platform,
    slotRamRequired, slotVramRequired, otherRamRequired, otherVramRequired, flags, unknown20,
    resourceTypes,
    resources,
    resourceInfoXml: file.subarray(xmlOffset).toString('latin1'),
  };
}

/** Resource names from the trailing XML (<SourceDataDescription>), in archive order. */
export function resourceNames(archive: SdsArchive): string[] {
  return [...archive.resourceInfoXml.matchAll(/<SourceDataDescription>([^<]*)<\/SourceDataDescription>/g)]
    .map(m => m[1] ?? '');
}

/**
 * A resource's name, read from its own data where the type stores one (MemFile, XML, Script), so it doesn't
 * depend on the trailing XML, which modding tools don't always keep in step with the resources.
 */
export function resourceName(resource: SdsResource, fallback: string): string {
  const d = resource.data;
  const str = (at: number): [string, number] | undefined => {
    if (at + 4 > d.length) return undefined;
    const n = d.readUInt32LE(at);
    if (n === 0 || n > 512 || at + 4 + n > d.length) return undefined;
    return [d.subarray(at + 4, at + 4 + n).toString('latin1').replace(/\0+$/, ''), at + 4 + n];
  };
  if (resource.typeName === 'MemFile') return str(0)?.[0] ?? fallback;
  if (resource.typeName === 'Script' && d.length >= 2) {
    // u16 length, folder path (e.g. /scripts/common/Police/)
    const n = d.readUInt16LE(0);
    if (n > 0 && 2 + n <= d.length) return d.subarray(2, 2 + n).toString('latin1');
  }
  if (resource.typeName === 'XML') {
    const tag = str(0);
    if (tag !== undefined) return str(tag[1] + 1)?.[0] ?? fallback; // tag, u8 flag, name
  }
  return fallback;
}

class Writer {
  private readonly chunks: Buffer[] = [];
  length = 0;
  bytes(b: Buffer): this { this.chunks.push(b); this.length += b.length; return this; }
  u8(v: number): this { const b = Buffer.alloc(1); b.writeUInt8(v); return this.bytes(b); }
  u16(v: number): this { const b = Buffer.alloc(2); b.writeUInt16LE(v); return this.bytes(b); }
  u32(v: number): this { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return this.bytes(b); }
  u32be(v: number): this { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return this.bytes(b); }
  stringU32(s: string): this { const b = Buffer.from(s, 'latin1'); return this.u32(b.length).bytes(b); }
  build(): Buffer { return Buffer.concat(this.chunks); }
}

/** Splits data into 0x4000-byte blocks, zlib-compressing each one unless that doesn't shrink it. */
function writeBlockStream(data: Buffer): Buffer {
  const w = new Writer().u32(BLOCK_SIGNATURE).u32(BLOCK_ALIGNMENT).u8(BLOCK_FLAGS);
  for (let o = 0; o < data.length; o += BLOCK_ALIGNMENT) {
    const block = data.subarray(o, Math.min(o + BLOCK_ALIGNMENT, data.length));
    const packed = deflateSync(block, { level: 9 });
    if (packed.length < block.length) {
      w.u32(32 + packed.length).u8(1).u32(block.length);
      for (const k of COMPRESSED_BLOCK_CONSTANTS) w.u32(k);
      w.u32(packed.length).u32(0).u32(0).u32(0).bytes(packed);
    } else {
      w.u32(block.length).u8(0).bytes(block);
    }
  }
  return w.u32(0).u8(0).build();
}

/**
 * Writes an unencrypted SDS v19 archive, the way modding tools ship them (the game reads those as
 * well as the encrypted retail tables.sds). Header checksums are recomputed; RAM figures are written
 * as given, so callers that change a resource's size adjust them (see adjustRamFigures).
 */
export function writeSds(archive: SdsArchive): Buffer {
  const types = new Writer().u32(archive.resourceTypes.length);
  for (const t of archive.resourceTypes) types.u32(t.id).stringU32(t.name).u32(t.parent);
  const typeTable = types.build();

  const stream = new Writer();
  for (const r of archive.resources) {
    const header = new Writer()
      .u32(r.typeId).u32(r.data.length + RESOURCE_HEADER_SIZE_IN_SIZE).u16(r.version)
      .u32(r.slotRamRequired).u32(r.slotVramRequired).u32(r.otherRamRequired).u32(r.otherVramRequired)
      .build();
    stream.bytes(header).u32(fnv32(header)).bytes(r.data);
  }
  const blocks = writeBlockStream(stream.build());

  const typeTableOffset = 72; // 12-byte header + hash + 52-byte file header + hash
  const blockTableOffset = typeTableOffset + typeTable.length;
  const xmlOffset = blockTableOffset + blocks.length;

  const head = new Writer().u32be(SIGNATURE).u32(19).bytes(Buffer.from('PC\0\0', 'latin1')).build();
  const fileHeader = new Writer()
    .u32(typeTableOffset).u32(blockTableOffset).u32(xmlOffset)
    .u32(archive.slotRamRequired).u32(archive.slotVramRequired)
    .u32(archive.otherRamRequired).u32(archive.otherVramRequired)
    .u32(archive.flags).bytes(archive.unknown20).u32(archive.resources.length)
    .build();
  return new Writer()
    .bytes(head).u32(fnv32(head))
    .bytes(fileHeader).u32(fnv32(fileHeader))
    .bytes(typeTable).bytes(blocks)
    .bytes(Buffer.from(archive.resourceInfoXml, 'latin1'))
    .build();
}
