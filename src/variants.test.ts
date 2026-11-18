import { describe, expect, it } from 'vitest';

import { pickInstaller, type Instruction } from './installers';
import { keepVariants, variantGroups } from './variants';

const instructionsFor = async (files: string[]) => pickInstaller(files)!.install(files);
const dests = (instructions: Instruction[]) =>
  instructions.filter(i => i.type === 'copy').map(i => `${i.source} -> ${i.destination}`);

describe('variants', () => {
  it('finds no choice when every file has its own place', async () => {
    expect(variantGroups(await instructionsFor(['Mod/pc/sds/tables/tables.sds', 'Mod/readme.txt']))).toEqual([]);
  });

  it('groups resolution folders that install the same files', async () => {
    const instructions = await instructionsFor([
      'HUD/1080p/pc/sds/gui/hud.sds',
      'HUD/1080p/pc/sds/gui/fonts.sds',
      'HUD/4K/pc/sds/gui/hud.sds',
      'HUD/4K/pc/sds/gui/fonts.sds',
      'HUD/4K/pc/sds/gui/extra.sds',
      'HUD/readme.txt',
    ]);
    const groups = variantGroups(instructions);
    expect(groups).toEqual([{ parent: 'HUD', options: ['1080p', '4K'], files: ['pc/sds/gui/hud.sds', 'pc/sds/gui/fonts.sds'] }]);
    // the 4K-only file goes with its folder
    expect(dests(keepVariants(instructions, groups, new Map([['HUD', '4K']])))).toEqual([
      'HUD/4K/pc/sds/gui/hud.sds -> pc/sds/gui/hud.sds',
      'HUD/4K/pc/sds/gui/fonts.sds -> pc/sds/gui/fonts.sds',
      'HUD/4K/pc/sds/gui/extra.sds -> pc/sds/gui/extra.sds',
    ]);
    expect(dests(keepVariants(instructions, groups, new Map([['HUD', '1080p']])))).toEqual([
      'HUD/1080p/pc/sds/gui/hud.sds -> pc/sds/gui/hud.sds',
      'HUD/1080p/pc/sds/gui/fonts.sds -> pc/sds/gui/fonts.sds',
    ]);
  });

  it('works for bare .sds variants at the archive root, case-insensitively', async () => {
    const instructions = await instructionsFor(['1080p/tables.sds', '4k/Tables.sds']);
    const groups = variantGroups(instructions);
    expect(groups).toEqual([{ parent: '', options: ['1080p', '4k'], files: ['pc/sds/tables/tables.sds'] }]);
    expect(dests(keepVariants(instructions, groups, new Map([['', '4K']])))).toEqual(['4k/Tables.sds -> pc/sds/tables/Tables.sds']);
  });

  it('keeps files outside the variant folders', async () => {
    const instructions = await instructionsFor([
      'Mod/pc/sds/cars/car.sds',
      'Mod/variants/A/pc/sds/tables/tables.sds',
      'Mod/variants/B/pc/sds/tables/tables.sds',
    ]);
    const groups = variantGroups(instructions);
    expect(groups.map(g => [g.parent, g.options])).toEqual([['Mod/variants', ['A', 'B']]]);
    expect(dests(keepVariants(instructions, groups, new Map([['Mod/variants', 'B']])))).toEqual([
      'Mod/pc/sds/cars/car.sds -> pc/sds/cars/car.sds',
      'Mod/variants/B/pc/sds/tables/tables.sds -> pc/sds/tables/tables.sds',
    ]);
  });

  it('asks separately for unrelated sets of variants', async () => {
    const groups = variantGroups(await instructionsFor([
      'Cars/old/pc/sds/cars/car.sds', 'Cars/new/pc/sds/cars/car.sds',
      'HUD/small/pc/sds/gui/hud.sds', 'HUD/big/pc/sds/gui/hud.sds',
    ]));
    expect(groups.map(g => [g.parent, g.options])).toEqual([['Cars', ['old', 'new']], ['HUD', ['small', 'big']]]);
  });
});
