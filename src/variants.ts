// Archives that hold several versions of the same mod side by side (`1080p/pc/...` and `4K/pc/...`):
// the installers map both to the same game path, and only one may be installed. Pure functions, so
// the installer can ask the player and the grouping can be tested without Vortex.
import type { Instruction } from './installers';

const segments = (file: string): string[] => file.split(/[\\/]/).filter(Boolean);
const lower = (s: string) => s.toLowerCase();

/** One choice: folders of the archive that hold versions of the same files. */
export interface VariantGroup {
  /** folder the variants sit in (`Mod`), '' for the archive root */
  parent: string;
  /** the variant folders' names (`1080p`, `4K`), in archive order */
  options: string[];
  /** game paths several variants install */
  files: string[];
}

/**
 * The variant folder of `source` among the duplicates of one destination: the first folder where
 * their paths differ. A copy right at that level (`pc/x.sds` next to `4K/pc/x.sds`) has no variant
 * folder of its own; it is named after the folder it starts with.
 */
function split(sources: string[]): { parent: string[]; option: (source: string) => string } {
  const segs = sources.map(segments);
  const parent: string[] = [];
  for (let i = 0; segs.every(s => i < s.length - 1 && lower(s[i]!) === lower(segs[0]![i]!)); i++) parent.push(segs[0]![i]!);
  return { parent, option: source => segments(source)[parent.length]! };
}

export function variantGroups(instructions: Instruction[]): VariantGroup[] {
  const byDest = new Map<string, string[]>();
  for (const i of instructions) {
    if (i.type !== 'copy') continue;
    const dest = lower(i.destination!);
    byDest.set(dest, [...(byDest.get(dest) ?? []), i.source!]);
  }
  const groups = new Map<string, VariantGroup>();
  for (const [dest, sources] of byDest) {
    if (sources.length < 2) continue;
    const { parent, option } = split(sources);
    const key = lower(parent.join('/'));
    const group = groups.get(key) ?? { parent: parent.join('/'), options: [], files: [] };
    for (const o of sources.map(option)) if (!group.options.some(x => lower(x) === lower(o))) group.options.push(o);
    group.files.push(instructions.find(i => i.type === 'copy' && lower(i.destination!) === dest)!.destination!);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** Drops the copies from the variant folders that weren't picked (`picks`: group parent -> option). */
export function keepVariants(instructions: Instruction[], groups: VariantGroup[], picks: Map<string, string>): Instruction[] {
  return instructions.filter(i => {
    if (i.type !== 'copy') return true;
    const segs = segments(i.source!);
    return groups.every(g => {
      const parent = segments(g.parent);
      const inParent = segs.length > parent.length + 1 && parent.every((p, k) => lower(p) === lower(segs[k]!));
      if (!inParent) return true;
      const option = segs[parent.length]!;
      const isOption = g.options.some(o => lower(o) === lower(option));
      return !isOption || lower(option) === lower(picks.get(g.parent) ?? g.options[0]!);
    });
  });
}
