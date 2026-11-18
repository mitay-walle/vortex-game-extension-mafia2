// Archive layouts from real Nexus mods (nexusmods.com/mafia2/mods/<id>), carried over from the
// GDL game.yaml test cases of 0.0.1.
import { describe, expect, it } from 'vitest';
import { pickInstaller } from './installers';

const plan = async (files: string[]) => {
  const inst = pickInstaller(files);
  if (inst === undefined) return undefined;
  const instructions = await inst.install(files);
  return {
    id: inst.id,
    modType: instructions.find(i => i.type === 'setmodtype')?.value,
    files: instructions.filter(i => i.type === 'copy').map(i => i.destination),
  };
};

describe('installers', () => {
  it('car with two wrapper folders, screenshots dropped (#627)', async () => {
    expect(await plan([
      'Military Shubert Armored Van/1.png',
      'Military Shubert Armored Van/Mafia II/pc/sds/cars/shubert_armoured.sds',
      'Military Shubert Armored Van/README.txt',
    ])).toEqual({ id: 'mafia2-game-folders', modType: 'root', files: ['pc/sds/cars/shubert_armoured.sds'] });
  });

  it('pc folder at the archive root, DLC folders kept (#525)', async () => {
    expect((await plan([
      'pc/sds/tables/tables.sds',
      'pc/dlcs/cnt_joes_adventures/sds/tables/tables.sds',
    ]))?.files).toEqual(['pc/sds/tables/tables.sds', 'pc/dlcs/cnt_joes_adventures/sds/tables/tables.sds']);
  });

  it('pc and edit in one wrapper folder (#594)', async () => {
    expect(await plan([
      'mafia 2 ultimate mod 2.1/edit/sdsconfig.bin',
      'mafia 2 ultimate mod 2.1/edit/tables/StreamMapa.bin',
      'mafia 2 ultimate mod 2.1/pc/sds/city/city.sds',
      'mafia 2 ultimate mod 2.1/readme.txt',
    ])).toEqual({
      id: 'mafia2-game-folders',
      modType: 'root',
      files: ['edit/sdsconfig.bin', 'edit/tables/StreamMapa.bin', 'pc/sds/city/city.sds'],
    });
  });

  it('edit/materials without wrapper, Windows separators (#418)', async () => {
    expect((await plan(['edit\\', 'edit\\materials\\', 'edit\\materials\\default.mtl']))?.files)
      .toEqual(['edit/materials/default.mtl']);
  });

  it('ASI plugin with its loader at the archive root (#619)', async () => {
    expect(await plan(['dinput8.dll', 'MafiaIIPhotoMode.asi']))
      .toEqual({ id: 'mafia2-asi', modType: 'exe-folder', files: ['dinput8.dll', 'MafiaIIPhotoMode.asi'] });
  });

  it('ASI plugin in a wrapper folder', async () => {
    expect((await plan(['Photo Mode/MafiaIIPhotoMode.asi', 'readme.txt']))?.files).toEqual(['MafiaIIPhotoMode.asi']);
  });

  it('ASI plugin inside pc/ goes through the game folders installer', async () => {
    expect(await plan(['Mod/pc/MafiaIIPhotoMode.asi']))
      .toEqual({ id: 'mafia2-game-folders', modType: 'root', files: ['pc/MafiaIIPhotoMode.asi'] });
  });

  it('sds folder without its pc parent goes under pc/', async () => {
    expect(await plan(['Car Mod/sds/cars/x.sds', 'Car Mod/preview.jpg']))
      .toEqual({ id: 'mafia2-sds-folder', modType: 'exe-folder', files: ['sds/cars/x.sds'] });
  });

  it('bare tables.sds goes to pc/sds/tables (#20)', async () => {
    expect(await plan(['tables.sds', 'readme.txt']))
      .toEqual({ id: 'mafia2-bare-sds', modType: 'root', files: ['pc/sds/tables/tables.sds'] });
  });

  it('leaves archives it doesn\'t recognise to Vortex', async () => {
    expect(await plan(['readme.txt', 'preset.ini'])).toBeUndefined();
  });
});
