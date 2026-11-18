// Crash tracking: after each game run, remember whether it crashed and which mods were enabled, so
// a crash can be pinned on the mods that changed since the last run that didn't crash. Works for
// any mod, because the game itself is the test.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

/** mod id -> fingerprint of its files */
export type Snapshot = Record<string, string>;

export interface CrashHistory {
  /** the last run that didn't crash */
  good?: { at: number; mods: Snapshot };
  /** the last run that crashed, if it came after `good` */
  crash?: {
    at: number;
    /** mods new or changed since `good`; all enabled mods when there is no `good` */
    suspects: string[];
    /** no run without a crash recorded yet */
    noGood: boolean;
  };
}

/**
 * `played`: the game got far enough to write its own files. A run that ends without a crash and
 * without that is Steam restarting the game, not a run that worked.
 */
export function recordRun(history: CrashHistory, mods: Snapshot, crashed: boolean, at: number, played: boolean): CrashHistory {
  if (!crashed) return played ? { good: { at, mods } } : history;
  const good = history.good?.mods;
  const suspects = Object.keys(mods).filter(id => good === undefined || good[id] !== mods[id]);
  return { ...history, crash: { at, suspects, noGood: good === undefined } };
}

/** The Problems column's text for a mod. */
export function crashNote(history: CrashHistory, modId: string): string {
  const c = history.crash;
  if (c === undefined || !c.suspects.includes(modId)) return '';
  const when = new Date(c.at).toLocaleString();
  return c.noGood
    ? `game crashed with it enabled (${when}); no run without a crash recorded yet`
    : `game crashed after it was enabled or changed (${when})`;
}

/** Short form for the column cell (the full text goes in its tooltip). */
export function crashShort(history: CrashHistory, modId: string): string {
  const c = history.crash;
  if (c === undefined || !c.suspects.includes(modId)) return '';
  const time = new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return c.noGood ? `crashed ${time}` : `crashed since enabled, ${time}`;
}

/** Notification text for the last crash; `names` maps mod ids to display names. */
export function crashMessage(history: CrashHistory, names: Record<string, string>): string {
  const c = history.crash!;
  const list = (ids: string[]) => ids.map(id => names[id] ?? id).join(', ');
  if (c.noGood) return `No run without a crash is recorded yet. Enabled: ${list(c.suspects) || 'no mods'}.`;
  if (c.suspects.length === 0) return 'Same mods as the last run that worked: probably not caused by a mod.';
  return `Changed since the last run that worked: ${list(c.suspects)}.`;
}

/** Fingerprint of a mod folder: its files' paths and sizes. */
export function fingerprint(folder: string): string {
  const files: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(path.join(folder, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else {
        try {
          files.push(`${r.toLowerCase()}:${statSync(path.join(folder, r)).size}`);
        } catch {
          // gone since the listing
        }
      }
    }
  };
  walk('');
  return createHash('sha1').update(files.sort().join('\n')).digest('hex');
}

/** Whether any file under `folder` (the game's Saves folder) was written since `since` (ms). */
export function writtenSince(folder: string, since: number): boolean {
  const walk = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    return entries.some(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      try {
        return statSync(p).mtimeMs >= since;
      } catch {
        return false;
      }
    });
  };
  return walk(folder);
}

const FILE = 'mafia2-crash-history.json';

export function loadHistory(stagingPath: string): CrashHistory {
  try {
    return JSON.parse(readFileSync(path.join(stagingPath, FILE), 'utf8')) as CrashHistory;
  } catch {
    return {};
  }
}

export const saveHistory = (stagingPath: string, history: CrashHistory): Promise<void> =>
  writeFile(path.join(stagingPath, FILE), JSON.stringify(history, null, 2));
