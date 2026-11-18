// Merges .sds archives that several mods replace, at deploy time (Vortex registerMerge).
//
// How Vortex drives it (src/renderer/src/extensions/mod_management/modMerging.ts):
// 1. `test` runs once per deploy; we use it to find which .sds files two or more enabled mods ship.
// 2. For each enabled mod, in deployment order, for each file that `filter` accepts:
// 3. the `baseFiles` (the game's own file, or its .vortex_backup) are copied once per deploy into
//    the merge folder (`__merged.root` in staging),
// 4. then `merge(modFile, mergeFolder)` is called.
// The merge folder's content is deployed like a mod that wins over the others.
//
// The merge is 3-way: every mod is compared with vanilla, so two mods that change different rows
// or resources of the same archive both apply. Vanilla is whatever Vortex put in the merge folder
// before the first merge call of a deploy; we recognise a fresh base because its content is not
// what we wrote last. Archives whose resources can only be matched by position (models, textures)
// aren't merged: the last mod's file is used whole, as without merging.
import { createHash } from 'node:crypto';
import { promises as fs, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { mergeSds, NotMergeableError, resourceKeys, type MergeConflict } from './sds/merge';
import { readSds, writeSds } from './sds/sds';

const md5 = (data: Buffer): string => createHash('md5').update(data).digest('hex');
const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/** Files the merge looks at: .sds under pc/ (main game and DLCs). */
export const isSds = (relPath: string): boolean => /^pc\/.*\.sds$/.test(norm(relPath));

/** Calls `found` with the path (`/`, as in the folder) of every .sds file under `folder`. */
export function walkSds(folder: string, found: (rel: string, abs: string) => void, rel = ''): void {
  let entries;
  try {
    entries = readdirSync(rel === '' ? folder : path.join(folder, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) walkSds(folder, found, r);
    else if (e.name.toLowerCase().endsWith('.sds')) found(r, path.join(folder, r));
  }
}

/** A file of a mod the player turned off (not deployed); `rel` lower case, `/`. */
export type Skip = (folder: string, rel: string) => boolean;

/**
 * Relative paths (lower case, `/`) of the .sds files that at least two of `modFolders` contain,
 * leaving out files the player turned off.
 */
export function sharedSdsFiles(modFolders: string[], skip: Skip = () => false): Set<string> {
  const seen = new Map<string, number>();
  for (const folder of modFolders) {
    const files = new Set<string>();
    walkSds(folder, r => { if (isSds(r) && !skip(folder, norm(r))) files.add(norm(r)); });
    for (const f of files) seen.set(f, (seen.get(f) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([f]) => f));
}

/**
 * Empty (0-byte) .sds files in `modFolders`, as `{ mod: folder name, file: path in the mod }`. The
 * game can't load an empty archive; some mods ship them on purpose to blank a model out.
 */
export function emptySdsFiles(modFolders: string[], skip: Skip = () => false): { mod: string; file: string }[] {
  const found: { mod: string; file: string }[] = [];
  for (const folder of modFolders) {
    walkSds(folder, (rel, abs) => {
      if (skip(folder, norm(rel))) return;
      try {
        if (statSync(abs).size === 0) found.push({ mod: path.basename(folder), file: rel });
      } catch {
        // gone since the listing
      }
    });
  }
  return found;
}

/** Splits an absolute staged file path into its mod folder name and the path inside the mod. */
export function splitStaged(stagingPath: string, filePath: string): { mod: string; rel: string } | undefined {
  const rel = path.relative(stagingPath, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  const [mod, ...rest] = rel.split(/[\\/]/);
  if (mod === undefined || rest.length === 0) return undefined;
  return { mod, rel: rest.join('/') };
}

export interface MergeReport {
  /** path inside the game folder, e.g. pc/sds/tables/tables.sds */
  file: string;
  mods: string[];
  conflicts: MergeConflict[];
  /** not a choice between mods: a table with changed columns, a new table */
  warnings: string[];
  /** why the file wasn't merged; one mod's file was used whole (the `WHOLE_FILE` conflict says whose) */
  notMerged?: string;
  /** the file the game gets is empty (0 bytes) */
  empty?: boolean;
}

/** Conflict id of a file that can't be merged: the choice is whose file the game gets. */
export const WHOLE_FILE = 'whole file';

interface State {
  vanilla?: Buffer;
  sources: string[];
  written: string;
}

export class SdsMerger {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly stagingPath: () => string,
    private readonly onReport: (report: MergeReport) => void = () => undefined,
    /** the user's choices for conflicts in a file: conflict id -> mod folder name */
    private readonly picksFor: (file: string) => ReadonlyMap<string, string> = () => new Map(),
  ) {}

  async merge(modFile: string, mergeDir: string): Promise<void> {
    const where = splitStaged(this.stagingPath(), modFile);
    if (where === undefined) throw new Error(`Mafia II merge: ${modFile} is not in the staging folder`);
    const output = path.join(mergeDir, where.rel);

    let current: Buffer | undefined;
    try {
      current = await fs.readFile(output);
    } catch {
      current = undefined;
    }

    let state = this.states.get(output);
    if (state === undefined || current === undefined || md5(current) !== state.written) {
      // a new deploy: Vortex put a fresh base there (or none, if it found no vanilla file)
      state = { vanilla: current, sources: [], written: '' };
      this.states.set(output, state);
    }
    state.sources.push(modFile);
    const label = (file: string) => splitStaged(this.stagingPath(), file)?.mod ?? file;

    let merged: Buffer;
    let conflicts: MergeConflict[] = [];
    let warnings: string[] = [];
    let notMerged: string | undefined;
    // a file that can't be merged is taken whole: from the mod the user picked, else the latest one
    const wholeFile = async (): Promise<Buffer> => {
      const labels = state.sources.map(label);
      const pick = this.picksFor(where.rel).get(WHOLE_FILE);
      const at = pick === undefined ? -1 : labels.lastIndexOf(pick);
      const used = at >= 0 ? state.sources[at]! : modFile;
      const sizes = await Promise.all(state.sources.map(async f => (await fs.stat(f)).size));
      const empty = labels.filter((_, i) => sizes[i] === 0);
      if (labels.length > 1) {
        conflicts = [{ id: WHOLE_FILE, mods: labels, used: label(used), picked: at >= 0, ...(empty.length > 0 && { empty }) }];
      }
      return fs.readFile(used);
    };
    if (state.vanilla === undefined) {
      merged = await wholeFile();
      notMerged = 'the game\'s own file was not found (verify the game files in Steam)';
    } else {
      try {
        const base = readSds(state.vanilla);
        resourceKeys(base, 'the game file'); // models and textures: refused before reading the mods
        const mods = await Promise.all(state.sources.map(async file => ({
          label: label(file),
          archive: readSds(await fs.readFile(file)),
        })));
        const result = mergeSds(base, mods, this.picksFor(where.rel));
        merged = writeSds(result.archive);
        conflicts = result.conflicts;
        warnings = result.warnings;
      } catch (err) {
        merged = await wholeFile();
        notMerged = err instanceof NotMergeableError
          ? `it holds models or textures, which can't be merged (${err.message})`
          : `it could not be read (${(err as Error).message})`;
      }
    }

    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, merged);
    state.written = md5(merged);
    this.onReport({
      file: where.rel,
      mods: state.sources.map(label),
      conflicts,
      warnings,
      ...(notMerged !== undefined && { notMerged }),
      ...(merged.length === 0 && { empty: true }),
    });
  }
}
