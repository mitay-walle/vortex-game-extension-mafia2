import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { crashMessage, crashNote, recordRun, writtenSince, type CrashHistory } from './crashes';

describe('recordRun', () => {
  it('blames every enabled mod while no run worked yet', () => {
    const h = recordRun({}, { a: '1', b: '1' }, true, 10, false);
    expect(h.crash).toEqual({ at: 10, suspects: ['a', 'b'], noGood: true });
    expect(crashNote(h, 'a')).toMatch(/no run without a crash/);
    expect(crashMessage(h, { a: 'Mod A', b: 'Mod B' })).toMatch(/Enabled: Mod A, Mod B/);
  });

  it('blames the mods added or changed since the last run that worked', () => {
    let h: CrashHistory = recordRun({}, { a: '1', b: '1' }, false, 10, true);
    h = recordRun(h, { a: '1', b: '2', c: '1' }, true, 20, false);
    expect(h.crash!.suspects).toEqual(['b', 'c']);
    expect(crashNote(h, 'a')).toBe('');
    expect(crashNote(h, 'c')).toMatch(/after it was enabled or changed/);
    expect(crashMessage(h, { c: 'Mod C' })).toBe('Changed since the last run that worked: b, Mod C.');
  });

  it('says when the mods are the same as a run that worked', () => {
    let h = recordRun({}, { a: '1' }, false, 10, true);
    h = recordRun(h, { a: '1' }, true, 20, false);
    expect(h.crash!.suspects).toEqual([]);
    expect(crashMessage(h, {})).toMatch(/probably not caused by a mod/);
  });

  it('clears the crash after a run that worked, and ignores Steam restarting the game', () => {
    let h = recordRun({}, { a: '1' }, true, 10, false);
    expect(recordRun(h, { a: '1' }, false, 20, false)).toBe(h);
    h = recordRun(h, { a: '1' }, false, 30, true);
    expect(h).toEqual({ good: { at: 30, mods: { a: '1' } } });
    expect(crashNote(h, 'a')).toBe('');
  });
});

describe('writtenSince', () => {
  it('finds a file written after the run started, in subfolders too', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mafia2-saves-'));
    try {
      const file = path.join(dir, '7656', 'profile.dat');
      mkdirSync(path.dirname(file));
      writeFileSync(file, 'x');
      utimesSync(file, 1000, 1000); // seconds
      expect(writtenSince(dir, 2_000_000)).toBe(false);
      expect(writtenSince(dir, 500_000)).toBe(true);
      expect(writtenSince(path.join(dir, 'missing'), 0)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
