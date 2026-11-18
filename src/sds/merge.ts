// Three-way merge of SDS archives (tables.sds, ingame.sds) against the vanilla file.
//
// Mods replace the whole archive, so two of them overwrite each other although they usually touch
// different things. Here each mod's archive is compared with vanilla and only what it changed is
// carried over:
// - tables inside the Table resource (weapons.tbl, vehicles.tbl, ...) row by row, rows keyed by
//   their first column when that is unique in vanilla and in every mod, by position otherwise; new
//   rows are appended;
// - every other resource (MemFile, XML, SoundTable) as a whole, keyed by its own name.
// A row two mods changed is merged field by field when the column layout is known, so one mod
// changing ammo and another the damage of the same weapon both apply. When two mods change the same
// field (or resource) differently, the later one in load order wins and the clash is reported; the
// user can pick per row or per field.
//
// XML resources re-saved by MafiaToolkit differ from vanilla byte-wise even when untouched (the
// binary XML is re-encoded). A resource whose strings are all the same as vanilla's is treated as
// unchanged; that can miss an edit of a value that isn't stored as a string.
import { diffFields, formatField, readColumns, rowName, type Column, type FieldDiff } from './fields';
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

/** Thrown when an archive holds resources that can only be told apart by position (models, textures). */
export class NotMergeableError extends Error {}

/**
 * Keys of an archive's resources: type and own name; a type that occurs once is keyed by the type
 * alone. Several unnamed resources of one type (Texture, Mipmap, buffers of a model) can't be matched
 * between archives, so such an archive is refused.
 */
export function resourceKeys(archive: SdsArchive, label: string): string[] {
  const counts = new Map<string, number>();
  for (const r of archive.resources) counts.set(r.typeName, (counts.get(r.typeName) ?? 0) + 1);
  const keys = archive.resources.map(r => {
    const name = resourceName(r, '');
    if (name !== '') return `${r.typeName} ${name}`;
    if (counts.get(r.typeName) === 1) return r.typeName;
    throw new NotMergeableError(`${label}: several unnamed ${r.typeName} resources`);
  });
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup !== undefined) throw new NotMergeableError(`${label}: ${dup} appears twice`);
  return keys;
}

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

/** A row or resource that two or more mods changed differently. */
export interface MergeConflict {
  /** stable id of the place, e.g. `table /tables/weapons.tbl id 11` or `XML /config/x` */
  id: string;
  /** mods that changed it, in load order */
  mods: string[];
  /** the mod whose version was used */
  used: string;
  /** true when `used` comes from `picks`, not from load order */
  picked: boolean;
  /** for table rows: the fields that differ (undefined when the column layout is unknown) */
  fields?: FieldDiff[];
  /**
   * true when the row was merged field by field: `fields` are only the contested ones, each with its
   * own pick id, and `used` is the mod most of them come from
   */
  perField?: boolean;
  /** for table rows: the row's own name, e.g. "Thompson 1928" */
  name?: string;
}

export const conflictText = (c: MergeConflict): string =>
  `${c.id}: changed by ${c.mods.join(' and ')}, using ${c.used}${c.picked ? ' (your choice)' : ''}`;

export interface MergeResult {
  archive: SdsArchive;
  /** what was taken from which mod */
  changes: string[];
  /** places where two mods changed the same thing differently */
  conflicts: MergeConflict[];
  /** problems that aren't a choice between mods (a table with changed columns, a new table) */
  warnings: string[];
}

/** Who changed what: place id -> [mod label, its version] in load order. */
type Changers = Map<string, { label: string; data: Buffer }[]>;

/**
 * Merges `mods` (in load order) onto `vanilla`. Where mods disagree, the later one wins, unless
 * `picks` names one of the mods that changed that place (conflict id -> mod label).
 */
export function mergeSds(
  vanilla: SdsArchive, mods: MergeSource[], picks: ReadonlyMap<string, string> = new Map(),
): MergeResult {
  const changes: string[] = [];
  const warnings: string[] = [];
  const changers: Changers = new Map();
  const addChange = (id: string, label: string, data: Buffer) => {
    const list = changers.get(id) ?? [];
    list.push({ label, data });
    changers.set(id, list);
  };

  // --- pass 1, whole resources other than Table: who changed which ---
  const vanillaKeys = resourceKeys(vanilla, 'vanilla');
  const modKeys = mods.map(m => resourceKeys(m.archive, m.label));
  const baseIndex = new Map(vanillaKeys.map((k, i) => [k, i]));
  const resourceChanges: { key: string; label: string; resource: SdsResource }[] = [];
  mods.forEach(({ label, archive }, m) => {
    archive.resources.forEach((r, i) => {
      if (r.typeName === 'Table') return;
      const key = modKeys[m]![i]!;
      const at = baseIndex.get(key);
      if (at !== undefined && sameContent(vanilla.resources[at]!, r)) return;
      resourceChanges.push({ key, label, resource: r });
      // an XML version that differs from an earlier mod's only in encoding counts as the same
      const earlier = resourceChanges.find(c => c.key === key && c.label !== label && sameContent(c.resource, r));
      addChange(key, label, earlier?.resource.data ?? r.data);
    });
  });

  // --- pass 1, tables row by row ---
  const tableAt = vanilla.resources.findIndex(r => r.typeName === 'Table');
  const baseTables = tableAt >= 0 ? readTables(vanilla.resources[tableAt]!.data) : [];
  const modTables = mods.map(({ label, archive }) => {
    const modResource = archive.resources.find(r => r.typeName === 'Table');
    return { label, tables: modResource === undefined ? [] : readTables(modResource.data) };
  });
  // rows are matched by their first column only where it is unique in vanilla and in every mod
  // (some mods clone rows by giving them an existing id); by position otherwise
  const uniqueIds = (t: Table) => new Set(t.rows.map(r => r.readUInt32LE(0))).size === t.rows.length;
  const keyed = new Set(baseTables.filter(t => t.rowSize >= 4 && uniqueIds(t)
    && modTables.every(m => m.tables.every(mt => mt.name !== t.name || mt.rowSize < 4 || uniqueIds(mt))))
    .map(t => t.name));
  const keyOf = (t: Table, row: Buffer, index: number) =>
    `table ${t.name} ${keyed.has(t.name) ? `id ${row.readUInt32LE(0)}` : `row ${index}`}`;
  const wholeTables = new Map<string, Table>(); // tables a mod changed the columns of
  const rowInfo = new Map<string, { table: Table; base: Buffer | undefined }>();
  for (const { label, tables } of modTables) {
    for (const modTable of tables) {
      const base = baseTables.find(t => t.name === modTable.name);
      if (base === undefined) {
        warnings.push(`table ${modTable.name}: new in ${label}, not merged`);
        continue;
      }
      if (modTable.rowSize !== base.rowSize || !sameColumns(modTable.columns, base.columns)) {
        warnings.push(`table ${base.name}: ${label} changed its columns, rows can't be merged; using ${label}'s table as a whole`);
        wholeTables.set(base.name, modTable);
        continue;
      }
      const baseByKey = new Map(base.rows.map((r, i) => [keyOf(base, r, i), r]));
      modTable.rows.forEach((row, i) => {
        const id = keyOf(base, row, i);
        const baseRow = baseByKey.get(id);
        if (baseRow?.equals(row)) return;
        addChange(id, label, row);
        rowInfo.set(id, { table: base, base: baseRow });
      });
    }
  }

  // --- who wins each place ---
  const winner = new Map<string, string>();
  const rowResult = new Map<string, Buffer>();
  const conflicts: MergeConflict[] = [];
  for (const [id, list] of changers) {
    const labels = list.map(c => c.label);
    const info = rowInfo.get(id);
    const name = info === undefined ? undefined : rowName(info.table.columns, info.table.rowSize, info.base ?? list[0]!.data);
    const named = name === undefined ? {} : { name };
    const cols = info?.base === undefined ? undefined : readColumns(info.table.columns, info.table.rowSize);
    if (info?.base !== undefined && cols !== undefined) {
      const merged = mergeRow(id, cols, info.base, list, picks);
      rowResult.set(id, merged.data);
      if (merged.fields.length > 0) {
        const uses = merged.fields.map(f => f.used!);
        const used = [...new Set(uses)].sort((a, b) => uses.filter(u => u === b).length - uses.filter(u => u === a).length)[0]!;
        conflicts.push({
          id, mods: labels.filter(l => merged.fields.some(f => f.mods!.includes(l))), used,
          picked: merged.fields.some(f => f.picked), fields: merged.fields, perField: true, ...named,
        });
      }
      continue;
    }
    const pick = picks.get(id);
    const picked = pick !== undefined && labels.includes(pick);
    const used = picked ? pick : labels[labels.length - 1]!;
    winner.set(id, used);
    if (info !== undefined) rowResult.set(id, list.find(c => c.label === used)!.data);
    const versions = new Set(list.map(c => c.data.toString('base64')));
    if (versions.size > 1) {
      const fields = info === undefined ? undefined : diffFields(info.table.columns, info.table.rowSize, info.base, list);
      conflicts.push({ id, mods: labels, used, picked, ...(fields !== undefined && { fields }), ...named });
    }
  }

  // --- pass 2: apply the winners ---
  const result = vanilla.resources.slice();
  const appended: { key: string; resource: SdsResource; label: string }[] = [];
  for (const { key, label, resource } of resourceChanges) {
    if (winner.get(key) !== label) continue;
    const at = baseIndex.get(key);
    if (at === undefined) appended.push({ key, resource, label });
    else {
      result[at] = resource;
      changes.push(`${key} from ${label}`);
    }
  }

  if (tableAt >= 0) {
    const baseResource = vanilla.resources[tableAt]!;
    const merged = baseTables.map((base): Table => {
      const whole = wholeTables.get(base.name);
      if (whole !== undefined) return { ...whole, rows: whole.rows.slice() };
      const table = { ...base, rows: base.rows.slice() };
      const index = new Map(base.rows.map((r, i) => [keyOf(base, r, i), i]));
      const done = new Set<string>();
      for (const { tables } of modTables) {
        const modTable = tables.find(t => t.name === base.name);
        if (modTable === undefined) continue;
        modTable.rows.forEach((row, i) => {
          const id = keyOf(base, row, i);
          const data = rowResult.get(id);
          if (data === undefined || done.has(id)) return;
          done.add(id);
          const at = index.get(id);
          if (at === undefined) {
            index.set(id, table.rows.length);
            table.rows.push(data);
          } else {
            table.rows[at] = data;
          }
        });
      }
      if (done.size > 0) {
        const from = [...new Set([...done].flatMap(id => changers.get(id)!.map(c => c.label)))];
        changes.push(`table ${base.name}: ${done.size} rows from ${from.join(', ')}`);
      }
      return table;
    });
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
    warnings,
  };
}

/**
 * Merges the versions of one row field by field against vanilla. A field changed by one mod (or the
 * same way by several) is taken; one changed differently is a conflict, resolved by a pick for the
 * field (`<row id> #<column>`), else a pick for the row, else the later mod.
 */
function mergeRow(
  rowId: string, cols: Column[], base: Buffer, list: { label: string; data: Buffer }[],
  picks: ReadonlyMap<string, string>,
): { data: Buffer; fields: FieldDiff[] } {
  const data = Buffer.from(base);
  const fields: FieldDiff[] = [];
  cols.forEach((col, i) => {
    const slice = (b: Buffer) => b.subarray(col.offset, col.offset + col.size);
    const vanilla = slice(base);
    const changed = list.filter(v => !slice(v.data).equals(vanilla));
    if (changed.length === 0) return;
    const distinct = new Set(changed.map(v => slice(v.data).toString('hex')));
    let from = changed[changed.length - 1]!;
    if (distinct.size > 1) {
      const fieldId = `${rowId} #${i}`;
      const pickField = picks.get(fieldId);
      const pickRow = picks.get(rowId);
      const pick = [pickField, pickRow].find(p => p !== undefined && changed.some(v => v.label === p));
      if (pick !== undefined) from = changed.find(v => v.label === pick)!;
      fields.push({
        id: fieldId,
        column: `#${i} ${col.hash.toString(16).padStart(8, '0')}`,
        type: col.type,
        vanilla: formatField(base, col),
        values: Object.fromEntries(list.map(v => [v.label, formatField(v.data, col)])),
        mods: changed.map(v => v.label),
        used: from.label,
        picked: pick !== undefined,
      });
    }
    slice(from.data).copy(data, col.offset);
  });
  return { data, fields };
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
