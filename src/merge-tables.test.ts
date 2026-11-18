// Drives TablesMerger the way Vortex's modMerging.ts does: copy the base into the merge folder,
// then call merge() once per mod in deployment order.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTablesSds, modLabel, TABLES_REL, TablesMerger, type MergeReport } from './merge-tables';
import { readSds, writeSds } from './sds/sds';
import { archive, rowsOf } from './sds/test-fixtures';

let staging: string;
let mergeDir: string;
let reports: MergeReport[];
let merger: TablesMerger;

const vanilla = writeSds(archive([[1, 10], [2, 20], [3, 30]]));

function stageMod(name: string, rows: [number, number][]): string {
  const file = path.join(staging, name, TABLES_REL);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, writeSds(archive(rows)));
  return file;
}

function newDeploy(base: Buffer | undefined): void {
  rmSync(mergeDir, { recursive: true, force: true });
  if (base !== undefined) {
    mkdirSync(path.join(mergeDir, path.dirname(TABLES_REL)), { recursive: true });
    writeFileSync(path.join(mergeDir, TABLES_REL), base);
  }
}

const mergedRows = () => rowsOf(readSds(readFileSync(path.join(mergeDir, TABLES_REL))));

beforeEach(() => {
  staging = mkdtempSync(path.join(tmpdir(), 'mafia2-merge-'));
  mergeDir = path.join(staging, '__merged.root');
  reports = [];
  merger = new TablesMerger(r => reports.push(r));
});
afterEach(() => rmSync(staging, { recursive: true, force: true }));

describe('TablesMerger', () => {
  it('applies rows changed by different mods', async () => {
    const a = stageMod('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const b = stageMod('Mod B', [[1, 10], [2, 20], [3, 33]]);
    newDeploy(vanilla);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(mergedRows()).toEqual([[1, 11], [2, 20], [3, 33]]);
    expect(reports.at(-1)).toMatchObject({ mods: ['Mod A', 'Mod B'], conflicts: [] });
  });

  it('lets the later mod win a row both changed, and reports it', async () => {
    const a = stageMod('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const b = stageMod('Mod B', [[1, 12], [2, 20], [3, 30]]);
    newDeploy(vanilla);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(mergedRows()[0]).toEqual([1, 12]);
    expect(reports.at(-1)!.conflicts).toHaveLength(1);
  });

  it('starts over on the next deploy instead of merging into its own output', async () => {
    const a = stageMod('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const b = stageMod('Mod B', [[1, 10], [2, 20], [3, 33]]);
    newDeploy(vanilla);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    newDeploy(vanilla); // Mod A disabled
    await merger.merge(b, mergeDir);
    expect(mergedRows()).toEqual([[1, 10], [2, 20], [3, 33]]);
    expect(reports.at(-1)!.mods).toEqual(['Mod B']);
  });

  it('falls back to "last mod wins" without a vanilla file', async () => {
    const a = stageMod('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const b = stageMod('Mod B', [[1, 10], [2, 20], [3, 33]]);
    newDeploy(undefined);
    await merger.merge(a, mergeDir);
    await merger.merge(b, mergeDir);
    expect(mergedRows()).toEqual([[1, 10], [2, 20], [3, 33]]);
    expect(reports.at(-1)!.noVanilla).toBe(true);
  });

  it('falls back to "last mod wins" when a file is not SDS', async () => {
    const a = stageMod('Mod A', [[1, 11], [2, 20], [3, 30]]);
    const broken = path.join(staging, 'Broken', TABLES_REL);
    mkdirSync(path.dirname(broken), { recursive: true });
    writeFileSync(broken, 'not an sds');
    newDeploy(vanilla);
    await merger.merge(a, mergeDir);
    await merger.merge(broken, mergeDir);
    expect(readFileSync(path.join(mergeDir, TABLES_REL), 'latin1')).toBe('not an sds');
    expect(reports.at(-1)!.error).toMatch(/^Broken: /);
  });
});

describe('filter and labels', () => {
  it('matches only the main tables.sds', () => {
    expect(isTablesSds('C:\\staging\\Mod\\pc\\sds\\tables\\tables.sds')).toBe(true);
    expect(isTablesSds('C:/staging/Mod/PC/SDS/Tables/Tables.sds')).toBe(true);
    expect(isTablesSds('C:/staging/Mod/pc/dlcs/cnt_greaser/sds/tables/tables.sds')).toBe(false);
    expect(isTablesSds('C:/staging/Mod/pc/sds/cars/tables.sds')).toBe(false);
  });

  it('names the mod folder', () => {
    expect(modLabel('C:\\staging\\No Police-616\\pc\\sds\\tables\\tables.sds')).toBe('No Police-616');
  });
});
