// State of the conflicts window (open/closed, the last deploy's reports, the saved choices) and the
// pure edits the window makes to the choices. The window is a Vortex dialog that controls its own
// visibility, so it subscribes to the store.
import type { Choices } from '../choices';
import { WHOLE_FILE, type MergeReport } from '../merge-sds';
import { COLUMN_HINTS, type FieldDiff } from '../sds/fields';
import type { MergeConflict } from '../sds/merge';

export interface ConflictsState {
  open: boolean;
  reports: MergeReport[];
  choices: Choices;
  /** mod folder -> name shown in the window */
  names: Record<string, string>;
  /** column hash (hex) -> name */
  columnNames: Record<string, string>;
  /** Mafia Toolkit is installed (its column names are in `columnNames`) */
  hasToolkit: boolean;
}

type Listener = (state: ConflictsState) => void;

export class ConflictsStore {
  private state: ConflictsState = { open: false, reports: [], choices: {}, names: {}, columnNames: {}, hasToolkit: false };
  private readonly listeners = new Set<Listener>();

  get(): ConflictsState {
    return this.state;
  }

  set(patch: Partial<ConflictsState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Files with conflicts, each with the mods that take part in them (load order). */
export function conflictGroups(reports: MergeReport[]) {
  return reports
    .filter(r => r.conflicts.length > 0)
    .map(r => ({
      file: r.file,
      mods: r.mods.filter(m => r.conflicts.some(c => c.mods.includes(m))),
      conflicts: r.conflicts,
    }));
}

const valid = (pick: string | undefined, mods: string[]) => (pick !== undefined && mods.includes(pick) ? pick : undefined);

/** The mod a contested field resolves to: its own pick, else the row's, else the later mod. */
export const fieldChoice = (choices: Choices, file: string, rowId: string, f: FieldDiff): string => {
  const mods = f.mods ?? [];
  return valid(choices[file]?.[f.id ?? ''], mods) ?? valid(choices[file]?.[rowId], mods) ?? mods[mods.length - 1]!;
};

/**
 * The mod a conflict resolves to, or undefined for a row merged field by field whose fields come
 * from different mods.
 */
export function rowChoice(choices: Choices, file: string, c: MergeConflict): string | undefined {
  if (c.perField === true && c.fields !== undefined) {
    const uses = new Set(c.fields.map(f => fieldChoice(choices, file, c.id, f)));
    return uses.size === 1 ? [...uses][0] : undefined;
  }
  return valid(choices[file]?.[c.id], c.mods) ?? c.mods[c.mods.length - 1];
}

const withFile = (choices: Choices, file: string, edit: (picks: Record<string, string>) => void): Choices => {
  const picks = { ...choices[file] };
  edit(picks);
  return { ...choices, [file]: picks };
};

/** Takes `mod` for the whole row (its field picks are dropped). */
const setRow = (picks: Record<string, string>, c: MergeConflict, mod: string) => {
  picks[c.id] = mod;
  for (const f of c.fields ?? []) if (f.id !== undefined) delete picks[f.id];
};

export const pickRow = (choices: Choices, file: string, c: MergeConflict, mod: string): Choices =>
  withFile(choices, file, picks => setRow(picks, c, mod));

export const pickField = (choices: Choices, file: string, fieldId: string, mod: string): Choices =>
  withFile(choices, file, picks => { picks[fieldId] = mod; });

/** Takes `mod` for every conflict of the file it takes part in. */
export const pickAll = (choices: Choices, file: string, conflicts: MergeConflict[], mod: string): Choices =>
  withFile(choices, file, picks => {
    for (const c of conflicts) if (c.mods.includes(mod)) setRow(picks, c, mod);
  });

export const resetFile = (choices: Choices, file: string): Choices => ({ ...choices, [file]: {} });

/** One line of the window: a contested field, or a whole row/resource when fields aren't known. */
export interface ConflictLine {
  key: string;
  /** the row's own name ("Thompson 1928") or its id ("weapons 11"); empty on the 2nd+ field of a row */
  place: string;
  /** the table or resource type ("weapons"), shown next to `place` */
  table: string;
  /** the column's name ("BulletsWeapon") or position ("#5"); empty for a whole row/resource */
  field: string;
  /** what the column means, when known */
  hint: string;
  /** full ids and hashes, for the tooltip */
  title: string;
  vanilla: string;
  /** mod -> its value; mods that didn't change it are left out */
  values: Record<string, string>;
  chosen: string;
  pick: (choices: Choices, mod: string) => Choices;
}

/** `table /tables/weapons.tbl id 11` -> weapons, 11; `XML /config/x` -> XML, x */
function placeParts(id: string): { table: string; key: string } {
  const t = /^table \/tables\/(.+?)\.tbl (?:id|row) (\S+)$/.exec(id);
  if (t !== null) return { table: t[1]!, key: t[2]! };
  const [type, ...rest] = id.split(' ');
  return { table: type!, key: rest.join(' ').split('/').pop() ?? '' };
}

export function conflictLines(
  choices: Choices, file: string, conflicts: MergeConflict[], columnNames: Record<string, string> = {},
): ConflictLine[] {
  return conflicts.flatMap(c => {
    const { table, key } = placeParts(c.id);
    const place = c.name ?? `${table} ${key}`;
    const where = c.name === undefined ? '' : `${table} ${key}`;
    if (c.perField === true && c.fields !== undefined) {
      return c.fields.map((f, i): ConflictLine => ({
        key: f.id!,
        place: i === 0 ? place : '',
        table: i === 0 ? where : '',
        field: columnNames[f.column.split(' ')[1]!] ?? f.column.split(' ')[0]!,
        hint: COLUMN_HINTS[f.column.split(' ')[1]!] ?? '',
        title: `${c.id}, column ${f.column}`,
        vanilla: f.vanilla,
        values: Object.fromEntries((f.mods ?? []).map(m => [m, f.values[m] ?? '?'])),
        chosen: fieldChoice(choices, file, c.id, f),
        pick: (ch, mod) => pickField(ch, file, f.id!, mod),
      }));
    }
    if (c.id === WHOLE_FILE) {
      return [{
        key: c.id,
        place: 'Whole file',
        table: '',
        field: '',
        hint: (c.empty?.length ?? 0) > 0
          ? 'can\'t be merged (models or textures): the game gets one mod\'s file; an empty one can stop the game from starting'
          : 'can\'t be merged (models or textures): the game gets one mod\'s file',
        title: `${file}: one mod's file is used whole`,
        vanilla: '',
        values: Object.fromEntries(c.mods.map(m => [m, c.empty?.includes(m) === true ? 'empty file (0 bytes)' : 'use this'])),
        chosen: rowChoice(choices, file, c)!,
        pick: (ch, mod) => pickRow(ch, file, c, mod),
      }];
    }
    return [{
      key: c.id,
      place,
      table: where,
      field: '',
      hint: '',
      title: c.id,
      vanilla: c.id.startsWith('table ') ? 'row' : 'file',
      values: Object.fromEntries(c.mods.map(m => [m, 'their version'])),
      chosen: rowChoice(choices, file, c)!,
      pick: (ch, mod) => pickRow(ch, file, c, mod),
    }];
  });
}
