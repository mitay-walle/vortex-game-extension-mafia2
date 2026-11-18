# Mafia II (Classic) support for Vortex

A [Vortex](https://www.nexusmods.com/about/vortex/) extension for Mafia II (2010, Classic, Steam 50130).
Not for the Definitive Edition.

[Nexus page](https://www.nexusmods.com/site/mods/2619)

## Features
- Game detection through Steam, launch via `pc/mafia2.exe`
- Installers for the layouts mods on [nexusmods.com/mafia2](https://www.nexusmods.com/mafia2) use:
  - `pc/` and `edit/` folders, also inside wrapper folders (screenshots and readmes are dropped)
  - `sds/` without its `pc/` parent goes under `pc/`
  - bare `.sds` files go where the game keeps the file of that name (`src/sds-paths.ts`);
    unknown names and side-by-side variants are refused with a message
  - ASI plugins and `dinput8.dll` go to `pc/`
- `pc/sds/tables/tables.sds` from several mods is merged on deploy, row by row against the game's own
  file. If two mods change the same row, the one lower in the mod list wins and Vortex lists those rows.

Not handled yet: variant archives (1080p/4K), Mafia Toolkit edits, DLC `tables.sds`.

## Build

Node 22+, pnpm.

```sh
pnpm install
pnpm test
pnpm run package   # out/mafia2-vortex-v<version>.zip
```

## Credits

The SDS reader/writer (`src/sds/`) is an independent TypeScript re-implementation based on the layout
and field names of [Gibbed.Illusion](https://github.com/gibbed/Gibbed.Illusion), Copyright (c) 2017 Rick
(gibbed), zlib License.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).
