// Drives SdsMerger the way Vortex's modMerging.ts does: copy the base into the merge folder, then
// call merge() once per mod in deployment order.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptySdsFiles, isSds, SdsMerger, sharedSdsFiles, splitStaged, WHOLE_FILE, type MergeReport } from './merge-sds';
import { readSds, writeSds, type SdsArchive } from './sds/sds';
import { archive, resource, rowsOf } from './sds/test-fixtures';

const TABLES = 'pc/sds/tables/tables.sds';

let staging: string;
let mergeDir: string;
let reports: MergeReport[];
let merger: SdsMerger;

const vanilla = writeSds(archive([[1, 10], [2, 20], [3, 30]]));

function stage(mod: string, content: Buffer | string, rel = TABLES): string {
  const file = path.join(staging, mod, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
const stageRows = (mod: string, rows: [number, number][], rel = TABLES) => stage(mod, writeSds(archive(rows)), rel);

function newDeploy(base: Buffer | undefined, rel = TABLES): void {
  rmSync(mergeDir, { recursive: true, force: true });
  if (base !== undefined) {
    mkdirSync(path.join(mergeDir, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(mergeDir, rel), base);
  }
}

const mergedRows = (rel = TABLES) => rowsOf(readSds(readFileSync(path.join(mergeDir, rel))));

/** A model-like archive: two unnamed Texture resources. */
function modelArchive(fill: number): SdsArchive {
  const tex = (n: number) => resource(0, 'Texture', Buffer.alloc(16, n));
  return { ...archive([]), resourceTypes: [{ id: 0, name: 'Texture', parent: 0 }], resources: [tex(fill), tex(fill + 1)] };
}

beforeEach(() => {
  staging = mkdtempSync(path.join(tmpdir(), 'mafia2-merge-'));
  mergeDir = path.join(staging, '__merged.root');
  reports = [];
  merger = new SdsMerger(() => staging, r => reports.push(r));
});
afterEach(() => rmSync(staging, { recursive: true, force: true }));

describe('SdsMerger', () => {
  it('applies rows changed by different mods', async () => {
    const a = stageRows('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const b = stageRows('Mod B', [[1, 10], [2, 20], [3, 33]]);
    newDeploy(vanilla);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(mergedRows()).toEqual([[1, 11], [2, 20], [3, 33]]);
    expect(reports.at(-1)).toEqual({ file: TABLES, mods: ['Mod A', 'Mod B'], conflicts: [], warnings: [] });
  });

  it('lets the later mod win a row both changed, and reports it', async () => {
    const a = stageRows('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const b = stageRows('Mod B', [[1, 12], [2, 20], [3, 30]]);
    newDeploy(vanilla);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(mergedRows()[0]).toEqual([1, 12]);
    expect(reports.at(-1)!.conflicts).toHaveLength(1);
  });

  it('merges a DLC file into its own place', async () => {
    const rel = 'pc/dlcs/cnt_joes_adventures/sds/tables/ingame.sds';
    const a = stageRows('Mod A', [[1, 11], [2, 20], [3, 30]], rel);
    const b = stageRows('Mod B', [[1, 10], [2, 22], [3, 30]], rel);
    newDeploy(vanilla, rel);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(mergedRows(rel)).toEqual([[1, 11], [2, 22], [3, 30]]);
    expect(reports.at(-1)!.file).toBe(rel);
  });

  it('starts over on the next deploy instead of merging into its own output', async () => {
    const a = stageRows('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const b = stageRows('Mod B', [[1, 10], [2, 20], [3, 33]]);
    newDeploy(vanilla);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    newDeploy(vanilla); // Mod A disabled
    await merger.merge(b, mergeDir);
    expect(mergedRows()).toEqual([[1, 10], [2, 20], [3, 33]]);
    expect(reports.at(-1)!.mods).toEqual(['Mod B']);
  });

  it('uses the last mod whole without a vanilla file', async () => {
    const a = stageRows('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const b = stageRows('Mod B', [[1, 10], [2, 20], [3, 33]]);
    newDeploy(undefined);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(mergedRows()).toEqual([[1, 10], [2, 20], [3, 33]]);
    expect(reports.at(-1)!.notMerged).toMatch(/not found/);
  });

  it('uses the last mod whole when a file is not SDS', async () => {
    const a = stageRows('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const broken = stage('Broken', 'not an sds');
    newDeploy(vanilla);
    await merger.merge(a, mergeDir);
    await merger.merge(broken, mergeDir);
    expect(readFileSync(path.join(mergeDir, TABLES), 'latin1')).toBe('not an sds');
    expect(reports.at(-1)!.notMerged).toMatch(/could not be read/);
  });

  it('uses the last mod whole for models and textures', async () => {
    const rel = 'pc/sds/police_char/police_char.sds';
    const a = stage('Mod A', writeSds(modelArchive(1)), rel);
    const b = stage('Mod B', writeSds(modelArchive(5)), rel);
    newDeploy(writeSds(modelArchive(0)), rel);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(readFileSync(path.join(mergeDir, rel)).equals(readFileSync(b))).toBe(true);
    expect(reports.at(-1)!.notMerged).toMatch(/models or textures/);
    expect(reports.at(-1)!.conflicts).toEqual([{ id: WHOLE_FILE, mods: ['Mod A', 'Mod B'], used: 'Mod B', picked: false }]);
  });

  it('takes a file that cannot be merged from the mod the user picked', async () => {
    const rel = 'pc/sds/police_char/police_char.sds';
    const a = stage('Mod A', writeSds(modelArchive(1)), rel);
    const b = stage('Mod B', writeSds(modelArchive(5)), rel);
    merger = new SdsMerger(() => staging, r => reports.push(r), () => new Map([[WHOLE_FILE, 'Mod A']]));
    newDeploy(writeSds(modelArchive(0)), rel);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(readFileSync(path.join(mergeDir, rel)).equals(readFileSync(a))).toBe(true);
    expect(reports.at(-1)!.conflicts).toMatchObject([{ id: WHOLE_FILE, used: 'Mod A', picked: true }]);
  });
});

describe('empty files', () => {
  // nexusmods.com/mafia2/mods/616 (No Police) ships its police archives as 0-byte files
  it('marks the mods whose copy of a whole file is empty, and an empty result', async () => {
    const rel = 'pc/sds/police_char/police_char.sds';
    const a = stage('No Police', Buffer.alloc(0), rel);
    const b = stage('State Police', writeSds(modelArchive(5)), rel);
    merger = new SdsMerger(() => staging, r => reports.push(r), () => new Map([[WHOLE_FILE, 'No Police']]));
    newDeploy(writeSds(modelArchive(0)), rel);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(reports.at(-1)!.conflicts).toMatchObject([{ id: WHOLE_FILE, used: 'No Police', empty: ['No Police'] }]);
    expect(reports.at(-1)!.empty).toBe(true);
  });

  it('does not flag a non-empty result', async () => {
    const rel = 'pc/sds/police_char/police_char.sds';
    const a = stage('No Police', Buffer.alloc(0), rel);
    const b = stage('State Police', writeSds(modelArchive(5)), rel);
    newDeploy(writeSds(modelArchive(0)), rel);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(reports.at(-1)!.empty).toBeUndefined();
  });

  it('lists 0-byte .sds files per mod', () => {
    stage('No Police', Buffer.alloc(0), 'pc/sds/police_char/m11police.sds');
    stage('No Police', 'x', 'pc/sds/tables/tables.sds');
    stage('Other', Buffer.alloc(0), 'readme.txt');
    expect(emptySdsFiles(['No Police', 'Other'].map(m => path.join(staging, m))))
      .toEqual([{ mod: 'No Police', file: 'pc/sds/police_char/m11police.sds' }]);
  });
});

describe('helpers', () => {
  it('finds .sds files that two or more mods ship', () => {
    stageRows('Mod A', [[1, 1]]);
    stageRows('Mod B', [[1, 2]]);
    stageRows('Mod B', [[1, 2]], 'pc/sds/cars/car.sds');
    stage('Mod C', 'x', 'pc/sds/police_char/police_char.sds');
    stage('Mod D', 'x', 'PC/SDS/Police_Char/police_char.sds');
    stage('Mod D', 'x', 'edit/sdsconfig.bin');
    expect(sharedSdsFiles(['Mod A', 'Mod B', 'Mod C', 'Mod D'].map(m => path.join(staging, m))))
      .toEqual(new Set([TABLES, 'pc/sds/police_char/police_char.sds']));
    // Mod D's police_char turned off: only Mod C ships it now
    const skip = (folder: string, rel: string) => path.basename(folder) === 'Mod D' && rel === 'pc/sds/police_char/police_char.sds';
    expect(sharedSdsFiles(['Mod A', 'Mod B', 'Mod C', 'Mod D'].map(m => path.join(staging, m)), skip))
      .toEqual(new Set([TABLES]));
  });

  it('only looks at .sds under pc/', () => {
    expect(isSds('pc/sds/tables/tables.sds')).toBe(true);
    expect(isSds('PC\\dlcs\\cnt_greaser\\sds\\tables\\ingame.sds')).toBe(true);
    expect(isSds('edit/sdsconfig.bin')).toBe(false);
    expect(isSds('sds/cars/x.sds')).toBe(false);
  });

  it('splits a staged path into mod and path inside it', () => {
    expect(splitStaged('C:\\staging', 'C:\\staging\\No Police-616\\pc\\sds\\tables\\tables.sds'))
      .toEqual({ mod: 'No Police-616', rel: 'pc/sds/tables/tables.sds' });
    expect(splitStaged('C:\\staging', 'D:\\elsewhere\\x.sds')).toBeUndefined();
  });
});
