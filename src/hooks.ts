import { SDS_PATHS } from './sds-paths';

const baseName = (archivePath: string): string => archivePath.split(/[\\/]/).pop() ?? archivePath;

/**
 * Installs archives that ship vanilla .sds files without their folders (the mod description says
 * "copy tables.sds to pc/sds/tables"). Each .sds goes to the folder its vanilla namesake lives in
 * (see sds-paths.ts). Other files (readmes, screenshots, .bat switches) are dropped.
 *
 * Refuses the archive, with a message saying why, when a .sds isn't a vanilla name (new content,
 * or a variant like `tables_dot.sds` meant to be renamed by hand): guessing would deploy a file the
 * game never reads. The same name twice (variants side by side) is left to the variant choice
 * (variants.ts).
 */
export async function installBareSds(
  files: string[],
  _destinationPath: string,
  _gameId: string,
): Promise<{ instructions: unknown[] }> {
  const sdsFiles = files.filter(file => !/[\\/]$/.test(file) && file.toLowerCase().endsWith('.sds'));

  const unknown = sdsFiles.filter(file => SDS_PATHS[baseName(file).toLowerCase()] === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `Mafia II: no vanilla file is named like ${unknown.map(baseName).join(', ')}, so it's unclear `
      + 'where in pc/ the game expects it. Check the mod description and install it by hand.',
    );
  }

  return {
    instructions: [
      ...sdsFiles.map(file => ({
        type: 'copy',
        source: file,
        destination: `${SDS_PATHS[baseName(file).toLowerCase()]}/${baseName(file)}`,
      })),
      { type: 'setmodtype', value: 'root' },
    ],
  };
}
