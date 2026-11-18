// Decodes table rows into fields, to show what two mods changed differently.
//
// A column is 8 bytes: name hash (u32), type (u8), two unknowns. Rows are the columns packed in
// order. Type sizes, worked out from the row sizes of the vanilla tables (Decal_Groups.tbl,
// MaterialsPhysics.tbl, vehicles.tbl, weapons.tbl, ...); meanings are a best guess:
//   1: bool (u32) · 4, 5: u32 (number, flags) · 2: float · 3: int · 6: 64-bit hash · 66: colour
//   8, 16, 32, 64: text of that many bytes · 132: 64-bit hash of the text, then 32 bytes of text
// Column names are stored only as FNV-1 32-bit hashes of the name. A few are known here (found by
// hashing guesses); Mafia Toolkit's Resources/hashes.txt has more and is read from the player's
// install when there is one (its licence doesn't allow shipping it).

export interface Column {
  hash: number;
  type: number;
  offset: number;
  size: number;
}

// 16 (text) and 66 (colour, 3 floats) don't occur in the vanilla tables seen so far
const SIZES: Record<number, number> = { 1: 4, 2: 4, 3: 4, 4: 4, 5: 4, 6: 8, 8: 8, 16: 16, 32: 32, 64: 64, 66: 12, 132: 40 };

/** Column layout of a table, or undefined when the sizes don't add up to the row size. */
export function readColumns(columns: Buffer, rowSize: number): Column[] | undefined {
  const raw = Array.from({ length: columns.length / 8 }, (_, i) => ({
    hash: columns.readUInt32LE(i * 8),
    type: columns[i * 8 + 4]!,
  }));
  const known = raw.reduce((s, c) => s + (SIZES[c.type] ?? 0), 0);
  const unknown = raw.filter(c => SIZES[c.type] === undefined);
  // one column of an unseen type: it takes what is left
  const rest = unknown.length === 1 ? rowSize - known : undefined;
  if (unknown.length > 1 || (unknown.length === 0 && known !== rowSize) || (rest !== undefined && rest <= 0)) {
    return undefined;
  }
  let offset = 0;
  return raw.map(c => {
    const size = SIZES[c.type] ?? rest!;
    const col = { ...c, offset, size };
    offset += size;
    return col;
  });
}

export function formatField(row: Buffer, col: Column): string {
  const b = row.subarray(col.offset, col.offset + col.size);
  if (b.length < col.size) return '?';
  switch (col.type) {
    case 2: {
      const f = b.readFloatLE(0);
      return Number.isInteger(f) ? String(f) : String(Number(f.toPrecision(6)));
    }
    case 3: return String(b.readInt32LE(0));
    case 1: case 4: case 5: return String(b.readUInt32LE(0));
    case 8: case 16: case 32: case 64: case 132: {
      const t = col.type === 132 ? b.subarray(8) : b;
      const end = t.indexOf(0);
      const text = t.subarray(0, end < 0 ? t.length : end).toString('latin1');
      return /^[\x20-\x7e\xa0-\xff]*$/.test(text) ? `"${text}"` : b.toString('hex');
    }
    default: return b.toString('hex');
  }
}

export interface FieldDiff {
  /** column position and name hash, e.g. `#5 a1b2c3d4` */
  column: string;
  type: number;
  vanilla: string;
  /** mod label -> value */
  values: Record<string, string>;
  /** set for a contested field of a row merged field by field: its pick id `<row id> #<column>` */
  id?: string;
  /** mods that changed this field, in load order */
  mods?: string[];
  /** the mod whose value was used */
  used?: string;
  picked?: boolean;
}

/** Fields where the versions don't all agree with vanilla, or with each other. */
export function diffFields(
  columns: Buffer, rowSize: number, base: Buffer | undefined, versions: { label: string; data: Buffer }[],
): FieldDiff[] | undefined {
  const cols = readColumns(columns, rowSize);
  if (cols === undefined) return undefined;
  const diffs: FieldDiff[] = [];
  cols.forEach((col, i) => {
    const vanilla = base === undefined ? '(new row)' : formatField(base, col);
    const values = Object.fromEntries(versions.map(v => [v.label, formatField(v.data, col)]));
    if (Object.values(values).every(v => v === vanilla)) return;
    diffs.push({ column: `#${i} ${col.hash.toString(16).padStart(8, '0')}`, type: col.type, vanilla, values });
  });
  return diffs;
}

/** FNV-1 32-bit, as the game hashes column names. */
export function fnv1(text: string): number {
  let h = 0x811c9dc5;
  for (const c of Buffer.from(text, 'latin1')) h = ((Math.imul(h, 0x1000193) >>> 0) ^ c) >>> 0;
  return h;
}

export const hashHex = (hash: number) => hash.toString(16).padStart(8, '0');

/**
 * Column names whose hash matches a vanilla column, keyed by hex hash. Found by hashing the strings
 * in mafia2.exe and the game's .sds archives (the first lines), and a few by hashing candidates
 * (the last line). A 32-bit match on a meaningful word is as good as certain.
 */
export const KNOWN_COLUMNS: Record<string, string> = Object.fromEntries([
  'ID', 'Id', 'HP', 'Name', 'name', 'guid', 'model', 'Type', 'TypeName', 'Description', 'Notes', 'Flags', 'flag',
  'Value', 'Range', 'Max', 'Speed', 'speed', 'scale', 'Visibility', 'ColorID', 'MaxDistance', 'Default', 'Group',
  'Material', 'MaterialId', 'SlideId', 'Sound', 'Water', 'FadeIn', 'FadeOut', 'Left', 'Right', 'Top', 'Bottom',
  'm_Particle',
  'BulletsWeapon', 'Weight', 'Reaction',
].map(n => [hashHex(fnv1(n)), n]));

/**
 * Column names from Mafia Toolkit's hashes.txt (one name per line) or custom_hashes.txt
 * (`<decimal hash> <name>` per line), keyed by hex hash.
 */
export function parseColumnNames(text: string): Record<string, string> {
  const names: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
    const m = /^(\d+)\s+(.+)$/.exec(line);
    if (m !== null) names[hashHex(Number(m[1]) >>> 0)] = m[2]!;
    else names[hashHex(fnv1(line))] = line;
  }
  return names;
}

/** A row's own name: its first text column (weapons: "Thompson 1928"). */
export function rowName(columns: Buffer, rowSize: number, row: Buffer): string | undefined {
  const col = readColumns(columns, rowSize)?.find(c => [8, 16, 32, 64].includes(c.type));
  if (col === undefined) return undefined;
  const text = formatField(row, col);
  return text.startsWith('"') && text.length > 2 ? text.slice(1, -1) : undefined;
}

/** What a column means, where it is clear from the vanilla values; keyed by hex hash. */
export const COLUMN_HINTS: Record<string, string> = {
  '5d67ac10': 'ammo in the gun (magazine)', // weapons.tbl BulletsWeapon: Thompson 50, MG42 250
  '634eda3e': 'spare ammo', // weapons.tbl BulletsAUX (name from Mafia Toolkit's list): Thompson 150, MG42 0, grenade 5
  'f3a06094': 'how the police react', // police_offences.tbl Reaction
};
