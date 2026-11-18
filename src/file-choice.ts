// Turning a mod's files off: stored as Vortex's own file overrides (absolute paths in the game
// folder that the mod doesn't deploy), so the game gets vanilla's copy or another mod's. Vortex's
// merge step doesn't read overrides, so the .sds merge checks them through `offFiles`.
import * as path from 'node:path';

const slash = (p: string) => p.split(/[\\/]/).filter(Boolean).join('/');

/** The mod's turned-off .sds files, as paths inside the mod (lower case, `/`). */
export function offFiles(fileOverrides: string[] | undefined, deployRoot: string): Set<string> {
  return new Set((fileOverrides ?? [])
    .filter(f => f.toLowerCase().endsWith('.sds'))
    .map(f => path.relative(deployRoot, f))
    .filter(rel => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel))
    .map(rel => slash(rel).toLowerCase()));
}

/**
 * New file overrides: `off` (paths inside the mod) replace the mod's .sds overrides; overrides of
 * other files, set elsewhere in Vortex, are kept.
 */
export function withOffFiles(fileOverrides: string[] | undefined, deployRoot: string, off: string[]): string[] {
  const others = (fileOverrides ?? []).filter(f => !f.toLowerCase().endsWith('.sds'));
  return [...others, ...off.map(rel => path.join(deployRoot, ...slash(rel).split('/')))];
}

/** Short text for the Problems column, e.g. `2 files off`. */
export const offText = (n: number): string => (n === 0 ? '' : `${n} ${n === 1 ? 'file' : 'files'} off`);
