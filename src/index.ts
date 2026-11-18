// Vortex extension for Mafia II (2010, Classic, Steam). Not for the Definitive Edition.
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as React from 'react';

import { loadChoices, picksFor, saveChoices } from './choices';
import { installers, type Instruction } from './installers';
import { emptySdsFiles, isSds, SdsMerger, sharedSdsFiles, splitStaged, walkSds, WHOLE_FILE, type MergeReport, type Skip } from './merge-sds';
import { offFiles, offText, withOffFiles } from './file-choice';
import { crashMessage, crashNote, crashShort, fingerprint, loadHistory, recordRun, saveHistory, writtenSince, type CrashHistory, type Snapshot } from './crashes';
import { watchGame } from './game-watch';
import { KNOWN_COLUMNS, parseColumnNames } from './sds/fields';
import { installToolkit, TOOLKIT_EXE } from './toolkit';
import { conflictText } from './sds/merge';
import { ConflictsDialog } from './ui/ConflictsDialog';
import { ConflictsStore } from './ui/conflicts-store';
import { keepVariants, variantGroups } from './variants';

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
  registerTableAttribute: (table: string, attribute: any) => void;
  registerAction: (group: string, position: number, icon: string, options: any, title: string, action: () => void, condition?: () => boolean) => void;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vortex = () => require('vortex-api');

const gamePath = (api: VortexApi): string | undefined =>
  vortex().selectors.discoveryByGame(api.getState(), GAME_ID)?.path;

/**
 * When the archive holds several versions of the same files side by side (`1080p/pc/...`,
 * `4K/pc/...`), asks which one to install, once per set of versions.
 */
async function chooseVariants(api: VortexApi, instructions: Instruction[]): Promise<Instruction[]> {
  const groups = variantGroups(instructions);
  const picks = new Map<string, string>();
  for (const g of groups) {
    const shown = g.files.slice(0, 3).join(', ') + (g.files.length > 3 ? `, and ${g.files.length - 3} more` : '');
    const result = await api.showDialog('question', 'Mafia II: choose a version', {
      text: `This archive has ${g.options.length} versions of the same files${g.parent === '' ? '' : ` in ${g.parent}`} `
        + `(${shown}). Only one can be installed; check the mod description for what each one is.`,
      choices: g.options.map((o, i) => ({ id: o, text: o, value: i === 0 })),
    }, [{ label: 'Cancel' }, { label: 'Install' }]);
    if (result.action !== 'Install') throw new (vortex().util.UserCanceled)();
    const picked = Object.entries(result.input ?? {}).find(([, on]) => on === true)?.[0];
    picks.set(g.parent, picked ?? g.options[0]!);
  }
  return groups.length === 0 ? instructions : keepVariants(instructions, groups, picks);
}

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
      async (files: string[]) => ({ instructions: await chooseVariants(context.api, await inst.install(files)) }),
    );
  }

  // .sds files that two or more enabled root-type mods ship; recomputed at the start of each deploy
  let shared = new Set<string>();
  const stagingPath = () => vortex().selectors.installPathForGame(context.api.getState(), GAME_ID) as string;
  /** where a mod of this type is deployed to: the game folder, or its pc folder */
  const deployRoot = (type?: string): string => {
    const root = gamePath(context.api) ?? '';
    return type === 'exe-folder' ? path.join(root, 'pc') : root;
  };
  const enabledMods = (type = 'root'): ModInfo[] => {
    const state = context.api.getState();
    const profileId = vortex().selectors.lastActiveProfileForGame(state, GAME_ID);
    const modState = state.persistent.profiles?.[profileId]?.modState ?? {};
    const mods = state.persistent.mods?.[GAME_ID] ?? {};
    return Object.values(mods as Record<string, ModInfo>)
      .filter(mod => (mod.type ?? '') === type && mod.installationPath !== undefined && modState[mod.id]?.enabled);
  };
  const enabledModFolders = (type = 'root'): string[] =>
    enabledMods(type).map(mod => path.join(stagingPath(), mod.installationPath!));
  /** the files the player turned off in these mods (Problems column, Files) */
  const skipFor = (mods: ModInfo[]): Skip => {
    const off = new Map(mods.map(mod => [path.join(stagingPath(), mod.installationPath!), offFiles(mod.fileOverrides, deployRoot(mod.type))]));
    return (folder, rel) => off.get(folder)?.has(rel) ?? false;
  };
  /**
   * Empty .sds files the game gets: from a single mod, or the merge's output (a file several mods
   * ship is the merge's to decide). `pc/...` paths.
   */
  const deployedEmptySds = (merged: MergeReport[]): EmptyFile[] => [
    ...emptySdsFiles(enabledModFolders('root'), skipFor(enabledMods('root'))),
    ...emptySdsFiles(enabledModFolders('exe-folder'), skipFor(enabledMods('exe-folder'))).map(e => ({ ...e, file: `pc/${e.file}` })),
  ]
    .filter(e => !shared.has(e.file.toLowerCase()))
    .concat(merged.filter(r => r.empty === true).map(r => ({
      mod: r.conflicts.find(c => c.id === WHOLE_FILE)?.used ?? r.mods[r.mods.length - 1]!, file: r.file,
    })));

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
      // Vortex's merge doesn't read file overrides: files turned off stay out of the merge here
      const skip = skipFor(enabledMods());
      shared = sharedSdsFiles(enabledModFolders(), skip);
      return {
        filter: (filePath: string) => {
          const where = splitStaged(stagingPath(), filePath);
          if (where === undefined || !isSds(where.rel) || !shared.has(where.rel.toLowerCase())) return false;
          if (skip(path.join(stagingPath(), where.mod), where.rel.toLowerCase())) return false;
          current = where.rel;
          return true;
        },
        baseFiles: () => (current === undefined ? [] : [{ in: path.join(discovery.path!, current), out: current }]),
      };
    },
    (filePath, mergeDir) => merger.merge(filePath, mergeDir),
    'root',
  );

  // crash tracking: each game run is recorded with the enabled mods; a crash is pinned on the mods
  // that changed since the last run that didn't crash
  let history: CrashHistory | undefined;
  const crashHistory = (): CrashHistory => (history ??= loadHistory(stagingPath()));
  const profileId = (): string => vortex().selectors.lastActiveProfileForGame(context.api.getState(), GAME_ID);
  const enabledSnapshot = (): Snapshot => {
    const state = context.api.getState();
    const modState = state.persistent.profiles?.[profileId()]?.modState ?? {};
    const mods = state.persistent.mods?.[GAME_ID] ?? {};
    return Object.fromEntries(Object.values(mods as Record<string, { id: string; installationPath?: string }>)
      .filter(mod => mod.installationPath !== undefined && modState[mod.id]?.enabled)
      .map(mod => [mod.id, fingerprint(path.join(stagingPath(), mod.installationPath!))]));
  };

  // Files: which of a mod's .sds files are deployed (and merged); the others are Vortex file overrides
  const modName = (mod: ModInfo) => shortName(String(vortex().util.renderModName?.(mod) ?? mod.attributes?.name ?? mod.id));
  const chooseFiles = async (mod: ModInfo) => {
    if (mod.installationPath === undefined) return;
    const files: string[] = [];
    walkSds(path.join(stagingPath(), mod.installationPath), rel => files.push(rel));
    const title = `Mafia II: files of ${modName(mod)}`;
    if (files.length === 0) {
      await context.api.showDialog('info', title, { text: 'This mod has no .sds files.' }, [{ label: 'Close' }]);
      return;
    }
    const off = offFiles(mod.fileOverrides, deployRoot(mod.type));
    const result = await context.api.showDialog('question', title, {
      text: 'Unticked files aren\'t deployed or merged: the game gets its own copy, or another mod\'s. '
        + 'To find a file that crashes the game, untick half, run the game, and narrow it down.',
      checkboxes: files.sort().map(f => ({ id: f, text: f, value: !off.has(f.toLowerCase()) })),
    }, [{ label: 'Cancel' }, { label: 'Apply' }]);
    if (result.action !== 'Apply') return;
    const nowOff = files.filter(f => result.input?.[f] === false);
    context.api.store.dispatch(vortex().actions.setFileOverride(GAME_ID, mod.id, withOffFiles(mod.fileOverrides, deployRoot(mod.type), nowOff)));
    context.api.events.emit('deploy-mods', () => undefined);
  };
  const offCount = (mod: ModInfo) => offFiles(mod.fileOverrides, deployRoot(mod.type)).size;
  /** the last deploy's merge conflicts the mod takes part in; `open`: decided by mod order, not by the player */
  const conflictCount = (mod: ModInfo) => {
    const mine = lastReports.flatMap(r => r.conflicts).filter(c => mod.installationPath !== undefined && c.mods.includes(mod.installationPath));
    return { total: mine.length, open: mine.filter(c => !c.picked).length };
  };
  const conflictText = ({ total, open }: { total: number; open: number }) =>
    open > 0 ? `${open} ${open === 1 ? 'conflict' : 'conflicts'} to resolve` : total > 0 ? `${total} ${total === 1 ? 'conflict' : 'conflicts'} chosen` : '';
  const problemsShort = (mod: ModInfo) =>
    [crashShort(crashHistory(), mod.id), conflictText(conflictCount(mod)), offText(offCount(mod))].filter(Boolean).join(', ');

  // Mods page column: problems seen with the mod (the game crashed after it was enabled), files
  // turned off, and the Files button
  let refreshProblemsColumn = () => undefined as void;
  context.registerTableAttribute('mods', {
    id: 'mafia2-problems',
    name: 'Problems',
    description: 'The game crashed after the mod was enabled or changed; Files: which of its .sds files are used',
    icon: 'warning',
    placement: 'table',
    isToggleable: true,
    isDefaultVisible: true,
    isSortable: true,
    edit: {},
    condition: () => vortex().selectors.activeGameId(context.api.getState()) === GAME_ID,
    externalData: (onChanged: () => void) => { refreshProblemsColumn = onChanged; },
    calc: (mod: ModInfo) => problemsShort(mod),
    customRenderer: (mod: ModInfo | ModInfo[]) => {
      if (Array.isArray(mod)) return null;
      const conflicts = conflictCount(mod);
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' } },
        React.createElement('span', { title: crashNote(crashHistory(), mod.id) || undefined, style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, problemsShort(mod)),
        conflicts.total > 0 ? React.createElement('button', {
          className: 'btn btn-default btn-xs',
          title: 'Open the merge conflicts window',
          onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); openConflicts(); },
        }, 'Conflicts') : null,
        React.createElement('button', {
          className: 'btn btn-default btn-xs',
          title: 'Choose which of the mod\'s .sds files are used',
          onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation(); void chooseFiles(mod); },
        }, 'Files'));
    },
  });

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
      refreshProblemsColumn();
      const names = modNames();
      notify(context.api, lastReports, deployedEmptySds(lastReports).map(e => ({ ...e, mod: names[e.mod] ?? e.mod })), openConflicts);
    });

    let snapshot: Snapshot = {};
    watchGame(
      () => vortex().selectors.activeGameId(context.api.getState()) === GAME_ID,
      () => { snapshot = enabledSnapshot(); },
      end => {
        const staging = stagingPath();
        // the game writes its Saves folder while it runs and when it exits normally
        const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        const saves = path.join(localAppData, '2K Games', 'Mafia II', 'Saves');
        history = recordRun(crashHistory(), snapshot, end.crashed, end.endedAt, writtenSince(saves, end.startedAt));
        void saveHistory(staging, history);
        refreshProblemsColumn();
        if (end.crashed) notifyCrash(history);
      },
    );
  });

  const notifyCrash = (h: CrashHistory) => {
    const c = h.crash!;
    const mods = context.api.getState().persistent.mods?.[GAME_ID] ?? {};
    const names = Object.fromEntries(Object.values(mods as Record<string, { id: string; attributes?: Record<string, unknown> }>)
      .map(mod => [mod.id, shortName(String(vortex().util.renderModName?.(mod) ?? mod.attributes?.name ?? mod.id))]));
    const disable = !c.noGood && c.suspects.length > 0;
    context.api.sendNotification({
      id: 'mafia2-crash',
      type: 'error',
      title: 'Mafia II crashed',
      message: crashMessage(h, names),
      actions: disable ? [{
        title: c.suspects.length === 1 ? 'Disable it' : 'Disable them',
        action: (dismiss: () => void) => {
          dismiss();
          for (const id of c.suspects) context.api.store.dispatch(vortex().actions.setModEnabled(profileId(), id, false));
          context.api.events.emit('deploy-mods', () => undefined);
        },
      }] : [],
    });
  };

  return true;
}

/** A mod name short enough for a column header: no archive extension or " - Mafia 2", at most 24 chars. */
export function shortName(name: string): string {
  const n = name.replace(/\.(zip|7z|rar)$/i, '').replace(/\s*-\s*Mafia\s*(2|II)\b/i, '').trim();
  return n.length > 24 ? `${n.slice(0, 23)}…` : n;
}

interface ModInfo {
  id: string;
  type?: string;
  installationPath?: string;
  fileOverrides?: string[];
  attributes?: Record<string, unknown>;
}

interface EmptyFile {
  mod: string;
  file: string;
}

function notify(api: VortexApi, reports: MergeReport[], empty: EmptyFile[], resolve: () => void): void {
  const emptyId = 'mafia2-empty-sds';
  api.dismissNotification(emptyId);
  if (empty.length > 0) {
    const list = empty.map(e => `${e.file} (${e.mod})`);
    api.sendNotification({
      id: emptyId,
      type: 'warning',
      title: `Mafia II: ${empty.length} empty .sds ${empty.length === 1 ? 'file' : 'files'} deployed`,
      message: list.slice(0, 2).join(', ') + (list.length > 2 ? `, and ${list.length - 2} more` : ''),
      actions: [{
        title: 'More',
        action: () => api.showDialog('info', 'Mafia II: empty .sds files', {
          text: 'These archives are 0 bytes. Some mods ship them on purpose to remove a model, but the game '
            + 'can fail to start or crash where it loads one. If it does, disable the mod, or pick another '
            + 'mod\'s copy in Merge conflicts when several mods ship the file.',
          message: list.join('\n'),
        }, [{ label: 'Close' }]),
      }],
    });
  }

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
