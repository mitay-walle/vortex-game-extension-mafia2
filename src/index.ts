// Vortex extension for Mafia II (2010, Classic, Steam). Not for the Definitive Edition.
import * as path from 'node:path';

import { installers } from './installers';
import { isTablesSds, TABLES_REL, TablesMerger, type MergeReport } from './merge-tables';

const GAME_ID = 'mafia2';
const STEAM_ID = '50130';

// Only the parts of the Vortex API this extension uses.
/* eslint-disable @typescript-eslint/no-explicit-any */
type VortexApi = {
  getState: () => any;
  sendNotification: (notification: any) => string;
  dismissNotification: (id: string) => void;
  showDialog: (type: string, title: string, content: any, actions: any[]) => Promise<any>;
  events: { on: (event: string, listener: (...args: any[]) => void) => void };
};
type Context = {
  api: VortexApi;
  registerGame: (game: any) => void;
  registerModType: (...args: any[]) => void;
  registerInstaller: (...args: any[]) => void;
  registerMerge: (test: any, merge: (filePath: string, mergeDir: string) => Promise<void>, modType: string) => void;
  once: (fn: () => void) => void;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vortex = () => require('vortex-api');

const gamePath = (api: VortexApi): string | undefined =>
  vortex().selectors.discoveryByGame(api.getState(), GAME_ID)?.path;

async function findGame(): Promise<string> {
  const found = await vortex().util.GameStoreHelper.findByAppId([STEAM_ID]);
  return found.gamePath;
}

function main(context: Context): boolean {
  context.registerGame({
    id: GAME_ID,
    name: 'Mafia II (Classic)',
    logo: 'gameart.webp',
    executable: () => 'pc/mafia2.exe',
    requiredFiles: ['pc/mafia2.exe'],
    queryPath: findGame,
    queryModPath: () => '.',
    mergeMods: true,
    environment: { SteamAPPId: STEAM_ID },
    details: { steamAppId: Number(STEAM_ID), nexusPageId: GAME_ID },
  });

  const isGame = (gameId: string) => gameId === GAME_ID;
  // ids kept from the GDL version (0.0.1), so mods installed with it keep their type
  context.registerModType('root', 50, isGame, () => gamePath(context.api) ?? '', async () => true,
    { name: 'Game Folder' });
  context.registerModType('exe-folder', 50, isGame,
    () => { const root = gamePath(context.api); return root === undefined ? '' : path.join(root, 'pc'); },
    async () => true, { name: 'Game pc Folder' });

  for (const inst of installers) {
    context.registerInstaller(
      inst.id,
      inst.priority,
      async (files: string[], gameId: string) => ({ supported: isGame(gameId) && inst.test(files), requiredFiles: [] }),
      async (files: string[]) => ({ instructions: await inst.install(files) }),
    );
  }

  const reports = new Map<string, MergeReport>();
  const merger = new TablesMerger(report => reports.set(report.output, report));
  context.registerMerge(
    (game: { id: string }, discovery: { path?: string }) => {
      if (game.id !== GAME_ID || discovery?.path === undefined) return undefined;
      return {
        baseFiles: () => [{ in: path.join(discovery.path!, TABLES_REL), out: TABLES_REL }],
        filter: isTablesSds,
      };
    },
    (filePath, mergeDir) => merger.merge(filePath, mergeDir),
    'root',
  );

  context.once(() => {
    context.api.events.on('did-deploy', () => {
      const all = [...reports.values()];
      reports.clear();
      notify(context.api, all);
    });
  });

  return true;
}

function notify(api: VortexApi, reports: MergeReport[]): void {
  const id = 'mafia2-tables-merge';
  api.dismissNotification(id);
  const merged = reports.filter(r => r.mods.length > 1);
  if (merged.length === 0) return;

  const problems = merged.flatMap(r => [
    ...(r.noVanilla ? ['The game\'s own tables.sds was not found, so the last mod replaced the others whole. Verify the game files in Steam and deploy again.'] : []),
    ...(r.error !== undefined ? [`Could not read ${r.error}. The last mod replaced the others whole.`] : []),
    ...r.conflicts,
  ]);
  const mods = merged.flatMap(r => r.mods).join(', ');

  api.sendNotification({
    id,
    type: problems.length > 0 ? 'warning' : 'success',
    title: 'tables.sds merged',
    message: problems.length > 0 ? `${problems.length} conflicts, the mod lower in the list won` : mods,
    displayMS: problems.length > 0 ? undefined : 5000,
    actions: problems.length === 0 ? [] : [{
      title: 'More',
      action: () => api.showDialog('info', 'Mafia II: tables.sds merge', {
        text: `Merged: ${mods}\n\nThese rows were changed by more than one mod. The one lower in the mod list won:`,
        message: problems.join('\n'),
      }, [{ label: 'Close' }]),
    }],
  });
}

export default main;
