// Three-way merge of SDS archives (in practice pc/sds/tables/tables.sds) against the vanilla file.
//
// Mods replace the whole archive, so two of them overwrite each other although they usually touch
// different things. Here each mod's archive is compared with vanilla and only what it changed is
// carried over:
// - tables inside the Table resource (weapons.tbl, vehicles.tbl, ...) row by row, rows keyed by
//   their first column when that is unique in vanilla, by position otherwise; new rows are appended;
// - every other resource (MemFile, XML, SoundTable) as a whole, keyed by its own name.
// When two mods change the same row or resource differently, the later one in load order wins and
// the clash is reported.
//
// XML resources re-saved by MafiaToolkit differ from vanilla byte-wise even when untouched (the
// binary XML is re-encoded). A resource whose strings are all the same as vanilla's is treated as
// unchanged; that can miss an edit of a value that isn't stored as a string.
import { resourceName, type SdsArchive, type SdsResource } from './sds';

interface Table {
  /** name hash, name, column count, two unknowns; rewritten as is */
  head: Buffer;
  name: string;
  rowSize: number;
  rows: Buffer[];
  columns: Buffer;
}

function readTables(data: Buffer): Table[] {
  const tables: Table[] = [];
  let p = 4;
  for (let i = data.readUInt32LE(0); i > 0; i--) {
    const start = p;
    p += 8;
    const nameLength = data.readUInt16LE(p);
    const name = data.subarray(p + 2, p + 2 + nameLength).toString('latin1');
    p += 2 + nameLength;
    const columnCount = data.readUInt16LE(p);
    p += 10;
    const head = data.subarray(start, p);
    const rowSize = data.readUInt32LE(p);
    const rowCount = data.readUInt32LE(p + 4);
    p += 8;
    const rows = Array.from({ length: rowCount }, (_, r) => data.subarray(p + r * rowSize, p + (r + 1) * rowSize));
    p += rowSize * rowCount;
    const columns = data.subarray(p, p + columnCount * 8);
    p += columnCount * 8;
    tables.push({ head, name, rowSize, rows, columns });
  }
  if (p !== data.length) throw new Error(`SDS Table resource: ${data.length - p} bytes left over`);
  return tables;
}

function writeTables(tables: Table[]): Buffer {
  const parts: Buffer[] = [];
  const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
  parts.push(u32(tables.length));
  for (const t of tables) parts.push(t.head, u32(t.rowSize), u32(t.rows.length), ...t.rows, t.columns);
  return Buffer.concat(parts);
}

const resourceKey = (r: SdsResource, index: number): string => `${r.typeName} ${resourceName(r, `#${index}`)}`;

const xmlStrings = (data: Buffer): string =>
  data.toString('latin1').split(/[^\x20-\x7e]+/).filter(s => s.length > 1).join('\n');

function sameContent(a: SdsResource, b: SdsResource): boolean {
  if (a.data.equals(b.data)) return true;
  return a.typeName === 'XML' && b.typeName === 'XML' && xmlStrings(a.data) === xmlStrings(b.data);
}

export interface MergeSource {
  /** shown in conflict messages */
  label: string;
  archive: SdsArchive;
}

export interface MergeResult {
  archive: SdsArchive;
  /** what was taken from which mod */
  changes: string[];
  /** places where two mods changed the same thing differently; the later one won */
  conflicts: string[];
}

/** Merges `mods` (in load order, later wins) onto `vanilla`. */
export function mergeSds(vanilla: SdsArchive, mods: MergeSource[]): MergeResult {
  const changes: string[] = [];
  const conflicts: string[] = [];

  // --- whole resources other than Table ---
  const baseIndex = new Map(vanilla.resources.map((r, i) => [resourceKey(r, i), i]));
  const result = vanilla.resources.slice();
  const takenFrom = new Map<number, string>();
  const appended: { key: string; resource: SdsResource; label: string }[] = [];

  for (const { label, archive } of mods) {
    archive.resources.forEach((r, i) => {
      if (r.typeName === 'Table') return;
      const key = resourceKey(r, i);
      const at = baseIndex.get(key);
      if (at === undefined) {
        const earlier = appended.find(a => a.key === key);
        if (earlier === undefined) appended.push({ key, resource: r, label });
        else if (!sameContent(earlier.resource, r)) {
          conflicts.push(`${key}: added by ${earlier.label} and ${label}, using ${label}`);
          Object.assign(earlier, { resource: r, label });
        }
        return;
      }
      if (sameContent(vanilla.resources[at]!, r)) return;
      const previous = takenFrom.get(at);
      if (previous !== undefined && !sameContent(result[at]!, r)) {
        conflicts.push(`${key}: changed by ${previous} and ${label}, using ${label}`);
      }
      result[at] = r;
      takenFrom.set(at, label);
    });
  }
  for (const [at, label] of takenFrom) changes.push(`${resourceKey(result[at]!, at)} from ${label}`);

  // --- tables, row by row ---
  const tableAt = vanilla.resources.findIndex(r => r.typeName === 'Table');
  if (tableAt >= 0) {
    const baseResource = vanilla.resources[tableAt]!;
    const baseTables = readTables(baseResource.data);
    const merged = baseTables.map(t => ({ ...t, rows: t.rows.slice() }));
    const rowOwners = new Map<string, Map<string, string>>(); // table name -> row key -> mod label
    for (const { label, archive } of mods) {
      const modResource = archive.resources.find(r => r.typeName === 'Table');
      if (modResource === undefined) continue;
      for (const modTable of readTables(modResource.data)) {
        const ti = baseTables.findIndex(t => t.name === modTable.name);
        if (ti < 0) {
          conflicts.push(`table ${modTable.name}: new in ${label}, not merged`);
          continue;
        }
        mergeTable(baseTables[ti]!, merged[ti]!, modTable, label, changes, conflicts, rowOwners);
      }
    }
    const data = writeTables(merged);
    if (!data.equals(baseResource.data)) {
      const delta = data.length - baseResource.data.length;
      result[tableAt] = { ...baseResource, data, slotRamRequired: baseResource.slotRamRequired + delta };
    }
  }

  // --- archive totals and the trailing resource info ---
  const resources = [...result, ...appended.map(a => a.resource)];
  for (const a of appended) changes.push(`${a.key} added from ${a.label}`);
  const sum = (field: 'slotRamRequired' | 'slotVramRequired' | 'otherRamRequired' | 'otherVramRequired') =>
    vanilla[field] + resources.reduce((s, r, i) => s + r[field] - (vanilla.resources[i]?.[field] ?? 0), 0);

  return {
    archive: {
      ...vanilla,
      slotRamRequired: sum('slotRamRequired'),
      slotVramRequired: sum('slotVramRequired'),
      otherRamRequired: sum('otherRamRequired'),
      otherVramRequired: sum('otherVramRequired'),
      resources,
      resourceInfoXml: appended.length === 0
        ? vanilla.resourceInfoXml
        // the game doesn't read it (mods ship it out of step with the resources); keep one entry each
        : vanilla.resourceInfoXml.replace(/<\/xml>/, `${appended.map(a => `\t<ResourceInfo>\r\n\t\t<TypeName>${a.resource.typeName}</TypeName>\r\n\t\t<SourceDataDescription>${a.key.slice(a.resource.typeName.length + 1)}</SourceDataDescription>\r\n\t</ResourceInfo>\r\n`).join('')}</xml>`),
    },
    changes,
    conflicts,
  };
}

/**
 * Columns are 8 bytes: name hash (4), type (1), two unknowns. MafiaToolkit zeroes the first unknown
 * on re-save (vanilla vehicles.tbl has 4 in two columns), so only hash and type are compared.
 */
function sameColumns(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 8) if (!a.subarray(i, i + 5).equals(b.subarray(i, i + 5))) return false;
  return true;
}

function mergeTable(
  base: Table, merged: Table, mod: Table, label: string,
  changes: string[], conflicts: string[], owners: Map<string, Map<string, string>>,
): void {
  if (mod.rowSize !== base.rowSize || !sameColumns(mod.columns, base.columns)) {
    conflicts.push(`table ${base.name}: ${label} changed its columns, rows can't be merged; using ${label}'s table as a whole`);
    Object.assign(merged, { head: mod.head, rowSize: mod.rowSize, rows: mod.rows.slice(), columns: mod.columns });
    return;
  }
  const keyed = new Set(base.rows.map(r => r.readUInt32LE(0))).size === base.rows.length;
  const keyOf = (row: Buffer, index: number) => (keyed ? `id ${row.readUInt32LE(0)}` : `row ${index}`);
  const baseByKey = new Map(base.rows.map((r, i) => [keyOf(r, i), r]));
  const mergedIndex = new Map(merged.rows.map((r, i) => [keyOf(r, i), i]));
  const tableOwners = owners.get(base.name) ?? new Map<string, string>();
  owners.set(base.name, tableOwners);

  let changed = 0;
  mod.rows.forEach((row, i) => {
    const key = keyOf(row, i);
    const baseRow = baseByKey.get(key);
    if (baseRow?.equals(row)) return;
    const at = mergedIndex.get(key);
    const previous = tableOwners.get(key);
    if (previous !== undefined && at !== undefined && !merged.rows[at]!.equals(row)) {
      conflicts.push(`table ${base.name} ${key}: changed by ${previous} and ${label}, using ${label}`);
    }
    if (at === undefined) {
      mergedIndex.set(key, merged.rows.length);
      merged.rows.push(row);
    } else {
      merged.rows[at] = row;
    }
    tableOwners.set(key, label);
    changed++;
  });
  if (changed > 0) changes.push(`table ${base.name}: ${changed} rows from ${label}`);
}
