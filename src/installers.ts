// Installers for the mod layouts seen on Nexus (mafia2 section). Each one is a pure function from
// the archive's file list to Vortex install instructions, so they can be tested without Vortex.
//
// Mod types:
// - `root`: the game folder. Mods with pc/ and edit/ folders deploy here as they are.
// - `exe-folder`: pc/, where mafia2.exe is. ASI plugins and a bare sds/ folder go here.
import { installBareSds } from './hooks';

export interface Instruction {
  type: 'copy' | 'setmodtype';
  source?: string;
  destination?: string;
  value?: string;
}

export interface Installer {
  id: string;
  priority: number;
  test: (files: string[]) => boolean;
  install: (files: string[]) => Promise<Instruction[]>;
}

const segments = (file: string): string[] => file.split(/[\\/]/).filter(Boolean);
const isDir = (file: string): boolean => /[\\/]$/.test(file);
const realFiles = (files: string[]): string[] => files.filter(file => !isDir(file));

/** Index of the first folder (not the file name) called `name`, case-insensitively, or -1. */
const folderIndex = (file: string, name: string): number => {
  const segs = segments(file);
  return segs.slice(0, -1).findIndex(seg => seg.toLowerCase() === name);
};
const hasFolder = (files: string[], name: string): boolean =>
  realFiles(files).some(file => folderIndex(file, name) >= 0);

const isAsi = (file: string): boolean => {
  const name = segments(file).pop()?.toLowerCase() ?? '';
  return name.endsWith('.asi') || name === 'dinput8.dll';
};
const hasAsi = (files: string[]): boolean => realFiles(files).some(isAsi);
const hasSds = (files: string[]): boolean => realFiles(files).some(file => file.toLowerCase().endsWith('.sds'));

/** Copies every file that has a folder `name`, cut from that folder onward. */
const cutAt = (files: string[], name: string): Instruction[] =>
  realFiles(files).flatMap(file => {
    const at = folderIndex(file, name);
    return at < 0 ? [] : [{ type: 'copy' as const, source: file, destination: segments(file).slice(at).join('/') }];
  });

const modType = (value: string): Instruction => ({ type: 'setmodtype', value });

export const installers: Installer[] = [
  {
    // pc/ and edit/ are siblings in the game root. Each folder is cut out of the archive from its
    // own name onward; wrapper folders and files outside them (screenshots, readmes) are dropped.
    id: 'mafia2-game-folders',
    priority: 20,
    test: files => hasFolder(files, 'pc') || hasFolder(files, 'edit'),
    install: async files => {
      const copies = realFiles(files).flatMap(file => {
        const pc = folderIndex(file, 'pc');
        const edit = folderIndex(file, 'edit');
        const candidates = [pc, edit].filter(i => i >= 0);
        if (candidates.length === 0) return [];
        const at = Math.min(...candidates);
        return [{ type: 'copy' as const, source: file, destination: segments(file).slice(at).join('/') }];
      });
      return [...copies, modType('root')];
    },
  },
  {
    // sds/ shipped without its pc/ parent, e.g. `Mod/sds/cars/x.sds`.
    id: 'mafia2-sds-folder',
    priority: 22,
    test: files => hasFolder(files, 'sds') && !hasFolder(files, 'pc') && !hasFolder(files, 'edit'),
    install: async files => [...cutAt(files, 'sds'), modType('exe-folder')],
  },
  {
    // .sds files without any folder: placed next to their vanilla namesake (see hooks.ts).
    id: 'mafia2-bare-sds',
    priority: 24,
    test: files =>
      hasSds(files) && !hasFolder(files, 'pc') && !hasFolder(files, 'edit') && !hasFolder(files, 'sds')
      && !hasAsi(files),
    install: async files => (await installBareSds(files, '', 'mafia2')).instructions as Instruction[],
  },
  {
    // ASI plugins (and the dinput8.dll loader): the folder holding the shallowest one goes to pc/.
    id: 'mafia2-asi',
    priority: 25,
    test: files => hasAsi(files) && !hasFolder(files, 'pc') && !hasFolder(files, 'edit'),
    install: async files => {
      const anchor = realFiles(files)
        .filter(isAsi)
        .sort((a, b) => segments(a).length - segments(b).length)[0]!;
      const root = segments(anchor).slice(0, -1);
      const under = (file: string) => {
        const segs = segments(file);
        return segs.length > root.length
          && root.every((seg, i) => seg.toLowerCase() === segs[i]!.toLowerCase());
      };
      const copies = realFiles(files)
        .filter(under)
        .map(file => ({ type: 'copy' as const, source: file, destination: segments(file).slice(root.length).join('/') }));
      return [...copies, modType('exe-folder')];
    },
  },
];

/** The installer Vortex would pick (lowest priority number that supports the files). */
export const pickInstaller = (files: string[]): Installer | undefined =>
  [...installers].sort((a, b) => a.priority - b.priority).find(inst => inst.test(files));
