import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { extractZip, readZip, setGameDirectory } from './toolkit';

/** A minimal zip: deflated entries, then the central directory. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(text.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(text.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('zip', () => {
  it('reads deflated entries', () => {
    expect(readZip(zip({ 'a.txt': 'hello', 'b/c.txt': 'world' })).map(e => [e.name, e.data.toString()]))
      .toEqual([['a.txt', 'hello'], ['b/c.txt', 'world']]);
  });

  it('extracts, dropping a single top folder', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mafia2-toolkit-'));
    try {
      await extractZip(zip({ 'Toolkit/MafiaToolkit.exe': 'exe', 'Toolkit/Resources/hashes.txt': 'ID' }), dir);
      expect(readFileSync(path.join(dir, 'MafiaToolkit.exe'), 'utf8')).toBe('exe');
      expect(readFileSync(path.join(dir, 'Resources', 'hashes.txt'), 'utf8')).toBe('ID');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses paths that leave the folder', async () => {
    await expect(extractZip(zip({ '../evil.txt': 'x' }), tmpdir())).rejects.toThrow(/unsafe/);
  });
});

describe('setGameDirectory', () => {
  it('creates the section in an empty or missing ini', () => {
    expect(setGameDirectory('', 'E:\\Mafia II')).toBe('[Directories]\nM2_Directory=E:\\Mafia II\n');
  });

  it('replaces the key and keeps other settings', () => {
    const ini = '[SDS]\r\nUseOodleCompression=0\r\n[Directories]\r\nM2_Directory=\r\nM3_Directory=x\r\n';
    expect(setGameDirectory(ini, 'E:\\Mafia II'))
      .toBe('[SDS]\r\nUseOodleCompression=0\r\n[Directories]\r\nM2_Directory=E:\\Mafia II\r\nM3_Directory=x\r\n');
  });

  it('adds the key to an existing section', () => {
    expect(setGameDirectory('[Directories]\nM3_Directory=x\n', 'D:\\g'))
      .toBe('[Directories]\nM2_Directory=D:\\g\nM3_Directory=x\n');
  });
});
