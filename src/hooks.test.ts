import { describe, expect, it } from 'vitest';
import { installBareSds } from './hooks';

const install = (files: string[]) => installBareSds(files, 'C:/staging/mod', 'mafia2');

describe('installBareSds', () => {
  // nexusmods.com/mafia2/mods/20: "Copy tables.sds to pc/sds/tables/"
  it('places a lone vanilla .sds next to its namesake and drops other files', async () => {
    const { instructions } = await install(['tables.sds', 'readme.txt', 'screenshot.jpg']);
    expect(instructions).toEqual([
      { type: 'copy', source: 'tables.sds', destination: 'pc/sds/tables/tables.sds' },
      { type: 'setmodtype', value: 'root' },
    ]);
  });

  // nexusmods.com/mafia2/mods/48: DLC outfits, each in its own DLC folder
  it('maps DLC files into their DLC folders, case-insensitively, from wrapper folders', async () => {
    const { instructions } = await install(['Remove glasses\\VitSuit.sds', 'Remove glasses\\vitbik.sds']);
    expect(instructions).toEqual([
      { type: 'copy', source: 'Remove glasses\\VitSuit.sds', destination: 'pc/dlcs/cnt_made_man/sds/player/VitSuit.sds' },
      { type: 'copy', source: 'Remove glasses\\vitbik.sds', destination: 'pc/dlcs/cnt_greaser/sds/player/vitbik.sds' },
      { type: 'setmodtype', value: 'root' },
    ]);
  });

  it('prefers the main game copy of a name the DLCs share', async () => {
    const { instructions } = await install(['jeep.sds']);
    expect(instructions[0]).toEqual({ type: 'copy', source: 'jeep.sds', destination: 'pc/sds/cars/jeep.sds' });
  });

  // nexusmods.com/mafia2/mods/614: tables_dot.sds is renamed to tables.sds by a .bat
  it('refuses a .sds that has no vanilla namesake', async () => {
    await expect(install(['CROSSHAIR_DOT_ON.bat', 'tables_dot.sds'])).rejects.toThrow(/tables_dot\.sds/);
  });

  it('maps side-by-side variants of the same file to the same place (the player picks one)', async () => {
    const { instructions } = await install(['1080p/tables.sds', '4K/tables.sds']);
    expect(instructions.slice(0, 2)).toEqual([
      { type: 'copy', source: '1080p/tables.sds', destination: 'pc/sds/tables/tables.sds' },
      { type: 'copy', source: '4K/tables.sds', destination: 'pc/sds/tables/tables.sds' },
    ]);
  });

  it('ignores directory entries', async () => {
    const { instructions } = await install(['mod/', 'mod/freeride.sds']);
    expect(instructions[0]).toEqual({ type: 'copy', source: 'mod/freeride.sds', destination: 'pc/sds/skies/freeride.sds' });
  });
});
