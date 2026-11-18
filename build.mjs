// Builds dist/ (index.js, info.json, gameart.webp); with --zip also out/mafia2-vortex-v<version>.zip.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vortex-api', 'electron'],
  sourcemap: true,
});

writeFileSync('dist/info.json', JSON.stringify({
  id: 'mafia2',
  name: 'Mafia II (Classic)',
  author: pkg.author,
  version: pkg.version,
  description: pkg.description,
}, null, 2));
copyFileSync('assets/gameart.webp', 'dist/gameart.webp');

if (process.argv.includes('--zip')) {
  mkdirSync('out', { recursive: true });
  const zip = `out/mafia2-vortex-v${pkg.version}.zip`;
  rmSync(zip, { force: true });
  writeFileSync(zip, makeZip(['index.js', 'index.js.map', 'info.json', 'gameart.webp']
    .map(name => ({ name, data: readFileSync(`dist/${name}`) }))));
  console.log(zip);
}

/** Minimal zip writer (deflate, no directories), so packaging needs no external tool. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const packed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const fields = (sig, extra) => {
      const b = Buffer.alloc(extra);
      b.writeUInt32LE(sig, 0);
      return b;
    };
    const local = fields(0x04034b50, 30);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0x00210000, 10); // 1980-01-01, fixed for reproducible archives
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = fields(0x02014b50, 46);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
