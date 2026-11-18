// Merges pc/sds/tables/tables.sds from several mods at deploy time (Vortex registerMerge).
//
// How Vortex drives it (src/renderer/src/extensions/mod_management/modMerging.ts):
// 1. For each enabled mod, in deployment order, for each file that `filter` accepts:
// 2. the `baseFiles` (the game's own tables.sds, or its .vortex_backup) are copied once per deploy
//    into the merge folder (`__merged.root` in staging),
// 3. then `merge(modFile, mergeFolder)` is called.
// The merge folder's content is deployed like a mod that wins over the others.
//
// The merge is 3-way: every mod is compared with vanilla, so two mods that change different rows
// of the same table both apply. Vanilla is whatever Vortex put in the merge folder before the first
// merge call of a deploy; we recognise a fresh base because its content is not what we wrote last.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { mergeSds } from './sds/merge';
import { readSds, writeSds } from './sds/sds';

export const TABLES_REL = 'pc/sds/tables/tables.sds';

const md5 = (data: Buffer): string => createHash('md5').update(data).digest('hex');

/** The merge filter: Vortex passes absolute paths of files in staged mods. */
export const isTablesSds = (filePath: string): boolean =>
  /(^|[\\/])pc[\\/]sds[\\/]tables[\\/]tables\.sds$/i.test(filePath);

/** Mod folder name for messages: the path part before `pc/sds/tables/tables.sds`. */
export const modLabel = (filePath: string): string => {
  const segs = filePath.split(/[\\/]/);
  return segs[segs.length - 5] ?? filePath;
};

export interface MergeReport {
  output: string;
  mods: string[];
  conflicts: string[];
  /** set when there was no vanilla file to compare with: mods were layered whole-file instead */
  noVanilla?: boolean;
  /** set when a file couldn't be read as SDS: the last mod won whole */
  error?: string;
}

interface State {
  vanilla?: Buffer;
  sources: string[];
  written: string;
}

export class TablesMerger {
  private readonly states = new Map<string, State>();

  constructor(private readonly onReport: (report: MergeReport) => void = () => undefined) {}

  async merge(modFile: string, mergeDir: string): Promise<void> {
    const output = path.join(mergeDir, TABLES_REL);
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

    let merged: Buffer;
    let conflicts: string[] = [];
    let error: string | undefined;
    if (state.vanilla === undefined) {
      // no base to diff against: the last mod wins whole, like without merging
      merged = await fs.readFile(modFile);
    } else {
      try {
        const mods = await Promise.all(state.sources.map(async file => ({
          label: modLabel(file),
          archive: readSds(await fs.readFile(file)),
        })));
        const result = mergeSds(readSds(state.vanilla), mods);
        merged = writeSds(result.archive);
        conflicts = result.conflicts;
      } catch (err) {
        // a file we can't parse: don't break the deploy, fall back to "last mod wins"
        merged = await fs.readFile(modFile);
        error = `${modLabel(modFile)}: ${(err as Error).message}`;
      }
    }

    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, merged);
    state.written = md5(merged);
    this.onReport({
      output,
      mods: state.sources.map(modLabel),
      conflicts,
      ...(state.vanilla === undefined && { noVanilla: true }),
      ...(error !== undefined && { error }),
    });
  }
}
