// Mafia Toolkit (https://github.com/Greavesy1899/MafiaToolkit): downloaded from its GitHub releases
// onto the player's machine on request. Its licence (PolyForm Strict) doesn't allow shipping it with
// this extension, so it is fetched from the official release, never bundled.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const TOOLKIT_REPO = 'Greavesy1899/MafiaToolkit';
export const TOOLKIT_EXE = 'MafiaToolkit.exe';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** Reads a zip (stored or deflated entries, no zip64) from its central directory. */
export function readZip(zip: Buffer): ZipEntry[] {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    p += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`${name}: unsupported zip compression ${method}`);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
  }
  return entries;
}

/** Writes the entries under `dest`; one top folder shared by all entries is dropped. */
export async function extractZip(zip: Buffer, dest: string): Promise<void> {
  const entries = readZip(zip);
  for (const e of entries) {
    const rel = path.normalize(e.name);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${e.name}: unsafe path in zip`);
  }
  const tops = new Set(entries.map(e => e.name.split('/')[0]));
  const strip = tops.size === 1 && entries.every(e => e.name.includes('/')) ? [...tops][0]!.length + 1 : 0;
  for (const e of entries) {
    const rel = path.normalize(e.name.slice(strip));
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${e.name}: unsafe path in zip`);
    const target = path.join(dest, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, e.data);
  }
}

/** Sets `[Directories] M2_Directory` in MafiaToolkit.ini text, keeping everything else. */
export function setGameDirectory(ini: string, gameDir: string): string {
  const eol = ini.includes('\r\n') ? '\r\n' : '\n';
  const lines = ini === '' ? [] : ini.split(/\r?\n/);
  const section = lines.findIndex(l => /^\s*\[Directories\]\s*$/i.test(l));
  if (section < 0) {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return [...lines, ...(lines.length > 0 ? [''] : []), '[Directories]', `M2_Directory=${gameDir}`, ''].join(eol);
  }
  let end = lines.findIndex((l, i) => i > section && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const key = lines.findIndex((l, i) => i > section && i < end && /^\s*M2_Directory\s*=/i.test(l));
  if (key >= 0) lines[key] = `M2_Directory=${gameDir}`;
  else lines.splice(section + 1, 0, `M2_Directory=${gameDir}`);
  return lines.join(eol);
}

interface Release {
  tag_name: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

/** The newest release's Windows zip. */
export async function latestToolkitZip(): Promise<{ version: string; url: string; size: number }> {
  const res = await fetch(`https://api.github.com/repos/${TOOLKIT_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest Mafia Toolkit release`);
  const release = await res.json() as Release;
  const asset = release.assets.find(a => /win.*\.zip$/i.test(a.name)) ?? release.assets.find(a => /\.zip$/i.test(a.name));
  if (asset === undefined) throw new Error(`Mafia Toolkit ${release.tag_name} has no zip to download`);
  return { version: release.tag_name, url: asset.browser_download_url, size: asset.size };
}

/** Downloads and unpacks the latest release into `dest`, points it at the game; returns the exe path. */
export async function installToolkit(dest: string, gameDir: string | undefined): Promise<{ exe: string; version: string }> {
  const { version, url } = await latestToolkitZip();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download of Mafia Toolkit ${version} failed: ${res.status}`);
  await extractZip(Buffer.from(await res.arrayBuffer()), dest);
  const exe = path.join(dest, TOOLKIT_EXE);
  await fs.access(exe).catch(() => { throw new Error(`Mafia Toolkit ${version}: ${TOOLKIT_EXE} not found in the download`); });
  if (gameDir !== undefined) {
    const ini = path.join(dest, 'MafiaToolkit.ini');
    const text = await fs.readFile(ini, 'latin1').catch(() => '');
    await fs.writeFile(ini, setGameDirectory(text, gameDir), 'latin1');
  }
  return { exe, version };
}
