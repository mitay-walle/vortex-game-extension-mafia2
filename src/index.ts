// Vortex extension for Mafia II (2010, Classic, Steam). Not for the Definitive Edition.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as React from 'react';

import { loadChoices, picksFor, saveChoices } from './choices';
import { installers } from './installers';
import { isSds, SdsMerger, sharedSdsFiles, splitStaged, type MergeReport } from './merge-sds';
import { KNOWN_COLUMNS, parseColumnNames } from './sds/fields';
import { installToolkit, TOOLKIT_EXE } from './toolkit';
import { conflictText } from './sds/merge';
import { ConflictsDialog } from './ui/ConflictsDialog';
import { ConflictsStore } from './ui/conflicts-store';

const GAME_ID = 'mafia2';
const STEAM_ID = '50130';
const TOOLKIT_ID = 'mafiatoolkit';

// Only the parts of the Vortex API this extension uses.
/* eslint-disable @typescript-eslint/no-explicit-any */
type VortexApi = {
  getState: () => any;
  store: { dispatch: (action: any) => void };
  showErrorNotification?: (message: string, details: unknown, options?: any) => void;
  sendNotification: (notification: any) => string;
  dismissNotification: (id: string) => void;
  showDialog: (type: string, title: string, content: any, actions: any[]) => Promise<any>;
  events: { on: (event: string, listener: (...args: any[]) => void) => void; emit: (event: string, ...args: any[]) => void };
};
type Context = {
  api: VortexApi;
  registerGame: (game: any) => void;
  registerModType: (...args: any[]) => void;
  registerInstaller: (...args: any[]) => void;
  registerMerge: (test: any, merge: (filePath: string, mergeDir: string) => Promise<void>, modType: string) => void;
  once: (fn: () => void) => void;
  registerDialog: (id: string, component: any, props?: () => any) => void;
  registerAction: (group: string, position: number, icon: string, options: any, title: string, action: () => void, condition?: () => boolean) => void;
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
    supportedTools: [{
      // https://github.com/Greavesy1899/MafiaToolkit, installed by the player; not found automatically
      id: TOOLKIT_ID,
      name: 'Mafia Toolkit',
      executable: () => 'MafiaToolkit.exe',
      requiredFiles: ['MafiaToolkit.exe'],
      relative: false,
    }],
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

  // .sds files that two or more enabled root-type mods ship; recomputed at the start of each deploy
  let shared = new Set<string>();
  const stagingPath = () => vortex().selectors.installPathForGame(context.api.getState(), GAME_ID) as string;
  const enabledModFolders = (): string[] => {
    const state = context.api.getState();
    const profileId = vortex().selectors.lastActiveProfileForGame(state, GAME_ID);
    const modState = state.persistent.profiles?.[profileId]?.modState ?? {};
    const mods = state.persistent.mods?.[GAME_ID] ?? {};
    return Object.values(mods as Record<string, { id: string; type?: string; installationPath?: string }>)
      .filter(mod => (mod.type ?? '') === 'root' && mod.installationPath !== undefined && modState[mod.id]?.enabled)
      .map(mod => path.join(stagingPath(), mod.installationPath!));
  };

  const reports = new Map<string, MergeReport>();
  let lastReports: MergeReport[] = [];
  const merger = new SdsMerger(
    stagingPath,
    report => reports.set(report.file, report),
    file => picksFor(loadChoices(stagingPath()), file),
  );
  let current: string | undefined; // the file `filter` accepted last: baseFiles is asked right after
  context.registerMerge(
    (game: { id: string }, discovery: { path?: string }) => {
      if (game.id !== GAME_ID || discovery?.path === undefined) return undefined;
      shared = sharedSdsFiles(enabledModFolders());
      return {
        filter: (filePath: string) => {
          const where = splitStaged(stagingPath(), filePath);
          if (where === undefined || !isSds(where.rel) || !shared.has(where.rel.toLowerCase())) return false;
          current = where.rel;
          return true;
        },
        baseFiles: () => (current === undefined ? [] : [{ in: path.join(discovery.path!, current), out: current }]),
      };
    },
    (filePath, mergeDir) => merger.merge(filePath, mergeDir),
    'root',
  );

  // the conflicts window
  const store = new ConflictsStore();
  const modNames = (): Record<string, string> => {
    const mods = context.api.getState().persistent.mods?.[GAME_ID] ?? {};
    return Object.fromEntries(Object.values(mods as Record<string, { id: string; installationPath?: string; attributes?: Record<string, unknown> }>)
      .map(mod => [mod.installationPath ?? mod.id, shortName(String(vortex().util.renderModName?.(mod) ?? mod.attributes?.name ?? mod.id))]));
  };
  // Mafia Toolkit: downloaded from GitHub on request, then registered as this game's tool
  const toolkitExe = (): string | undefined =>
    context.api.getState().settings?.gameMode?.discovered?.[GAME_ID]?.tools?.[TOOLKIT_ID]?.path;
  let installing = false;
  const installMafiaToolkit = async () => {
    if (installing) return;
    installing = true;
    const id = 'mafia2-toolkit-install';
    context.api.sendNotification({ id, type: 'activity', title: 'Mafia Toolkit', message: 'Downloading from GitHub…' });
    try {
      const dest = path.join(vortex().util.getVortexPath('userData'), GAME_ID, 'MafiaToolkit');
      const { exe, version } = await installToolkit(dest, gamePath(context.api));
      context.api.store.dispatch(vortex().actions.addDiscoveredTool(GAME_ID, TOOLKIT_ID, {
        id: TOOLKIT_ID, name: 'Mafia Toolkit', path: exe, workingDirectory: path.dirname(exe),
        requiredFiles: [TOOLKIT_EXE], hidden: false, custom: false,
      }, true));
      context.api.sendNotification({
        id, type: 'success', title: `Mafia Toolkit ${version} installed`, displayMS: 8000,
        message: 'It is on the dashboard\'s tools; it needs the .NET 8 Desktop Runtime.',
      });
      store.set({ columnNames: columnNames(), hasToolkit: true });
    } catch (err) {
      context.api.dismissNotification(id);
      context.api.showErrorNotification?.('Mafia Toolkit could not be installed', err, { allowReport: false });
    } finally {
      installing = false;
    }
  };

  // column names: the few known ones, plus Mafia Toolkit's lists when it is installed
  const columnNames = (): Record<string, string> => {
    const exe = toolkitExe();
    const fromToolkit = exe === undefined ? [] : ['hashes.txt', 'custom_hashes.txt'].map(name => {
      try {
        return parseColumnNames(readFileSync(path.join(path.dirname(exe), 'Resources', name), 'latin1'));
      } catch {
        return {};
      }
    });
    return Object.assign({}, KNOWN_COLUMNS, ...fromToolkit);
  };
  const openConflicts = () => store.set({
    open: true, reports: lastReports, choices: loadChoices(stagingPath()), names: modNames(), columnNames: columnNames(),
    hasToolkit: toolkitExe() !== undefined,
  });
  const apply = (choices: Record<string, Record<string, string>>) => {
    void saveChoices(stagingPath(), choices).then(() => context.api.events.emit('deploy-mods', () => undefined));
  };
  context.registerDialog('mafia2-merge-conflicts', () => React.createElement(ConflictsDialog, {
    store, onApply: apply, onInstallToolkit: () => void installMafiaToolkit(),
  }));
  context.registerAction('mod-icons', 121, 'download', {}, 'Install Mafia Toolkit', () => void installMafiaToolkit(),
    () => vortex().selectors.activeGameId(context.api.getState()) === GAME_ID && toolkitExe() === undefined);
  context.registerAction('mod-icons', 120, 'conflict', {}, 'Merge conflicts', openConflicts,
    () => vortex().selectors.activeGameId(context.api.getState()) === GAME_ID);

  context.once(() => {
    // offer Mafia Toolkit when the game is managed and the toolkit isn't set up: on switching to the
    // game, and at start when it already is the active one (activation happens before this runs)
    const offerToolkit = (gameId: string | undefined) => {
      if (gameId !== GAME_ID || toolkitExe() !== undefined) return;
      context.api.sendNotification({
        id: 'mafia2-toolkit-offer', type: 'info', title: 'Mafia Toolkit',
        message: 'The modding tool for Mafia II: opens and edits .sds files, and names table columns in the merge conflicts window.',
        actions: [{ title: 'Install', action: (dismiss: () => void) => { dismiss(); void installMafiaToolkit(); } }],
      });
    };
    context.api.events.on('gamemode-activated', offerToolkit);
    offerToolkit(vortex().selectors.activeGameId(context.api.getState()));
    context.api.events.on('did-deploy', () => {
      lastReports = [...reports.values()];
      reports.clear();
      notify(context.api, lastReports, openConflicts);
    });
  });

  return true;
}

/** A mod name short enough for a column header: no archive extension or " - Mafia 2", at most 24 chars. */
export function shortName(name: string): string {
  const n = name.replace(/\.(zip|7z|rar)$/i, '').replace(/\s*-\s*Mafia\s*(2|II)\b/i, '').trim();
  return n.length > 24 ? `${n.slice(0, 23)}…` : n;
}

function notify(api: VortexApi, reports: MergeReport[], resolve: () => void): void {
  const id = 'mafia2-sds-merge';
  api.dismissNotification(id);
  if (reports.length === 0) return;

  const lines = reports.flatMap(r => [
    `${r.file}: ${r.mods.join(', ')}`,
    ...(r.notMerged !== undefined ? [`  not merged, one mod's file used whole: ${r.notMerged}`] : []),
    ...r.warnings.map(w => `  ${w}`),
    ...r.conflicts.map(c => `  ${conflictText(c)}`),
  ]);
  const conflicts = reports.reduce((n, r) => n + r.conflicts.length, 0);
  // conflicts without a choice (a file taken whole counts as one) are what the player should look at
  const open = reports.reduce((n, r) => n + r.conflicts.filter(c => !c.picked).length, 0);
  const notMerged = reports.filter(r => r.notMerged !== undefined).length;
  const merged = reports.length - notMerged;

  api.sendNotification({
    id,
    type: open > 0 ? 'warning' : 'success',
    title: `Mafia II: ${merged} of ${reports.length} shared .sds files merged`,
    message: [
      ...(open > 0 ? [`${open} conflicts decided by mod order, Resolve to choose`] : []),
      ...(conflicts > open ? [open > 0 ? `${conflicts - open} decided by your choice` : `all ${conflicts} conflicts decided by your choice`] : []),
      ...(notMerged > 0 ? [`${notMerged} can't be merged, one mod's file is used whole`] : []),
    ].join('; ') || reports.map(r => r.file).join(', '),
    ...(open === 0 && { displayMS: 5000 }),
    actions: [
      // everything chosen: the window is still there to change a choice, not to resolve anything
      ...(conflicts > 0 ? [{ title: open > 0 ? 'Resolve' : 'Change choices', action: (dismiss: () => void) => { dismiss(); resolve(); } }] : []),
      {
        title: 'More',
        action: () => api.showDialog('info', 'Mafia II: merged .sds files', {
          text: 'Files several enabled mods replace. Each mod is compared with the game\'s own file, and what '
            + 'it changed is kept. Where two mods changed the same row, the one lower in the mod list won, '
            + 'unless you chose otherwise with Resolve (also on the Mods toolbar: Merge conflicts).',
          message: lines.join('\n'),
        }, [{ label: 'Close' }]),
      },
    ],
  });
}

export default main;
