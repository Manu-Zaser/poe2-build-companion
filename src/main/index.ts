import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, shell } from 'electron';
import { existsSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { decodeBuildCode, encodeBuildCode, MAX_CODE_LENGTH, normalizeBuildCode } from '../shared/buildcode';
import { readItemText as readGameItemText } from '@poe2/core/clipboard';
import { validateHotkey } from '@poe2/core/hotkey';
import { foregroundWindowHandle } from '@poe2/core/win32';
import { keepWindowFrameClean } from '@poe2/core/window';
import { characterLink, fetchNinjaBuild, fetchNinjaIcons, parseCharacterLink } from '../shared/ninja';
import type { McpSetup,
  BuildSource,
  BuildView,
  Comparison,
  EquipRecord,
  ItemIcon,
  NinjaCharacter,
  OverlayContent,
  Overview,
  PobFileEntry,
  Settings,
  StoredBuild,
  StoredState,
  StoredTarget,
  TargetView,
  UpgradeRequest,
  UpgradeRun,
} from '../shared/types';
import { fetchCurrencyRates, fetchLeagues, type CurrencyRates } from '@poe2/core/ninja';
import { RateLimitError, TradeClient } from '@poe2/core/trade';
import { UPGRADE_SLOTS, weightedSearchUrl, type TradeQuery } from '../shared/upgrades';
import { runUpgradeSearch, SearchCancelled } from './upgradesearch';
import { fitForSlot, parseTargetBuild, type Fit, type TargetBuild } from '../shared/targets';
import { buildFromLink } from '../shared/targetlink';
import { makeTarget, targetName } from '../shared/targetstore';
import { judgeItem } from '../shared/verdict';
import { Engine } from './engine';
import { checkForUpdates, downloadUpdate, initUpdates, installUpdate, openReleasePage, updateState } from './updater';
import { log } from './log';
import { Overlay } from './overlay';
import { findBuildsDir, listBuildFiles, readBuildFile, watchBuildFile } from './pobfile';

/**
 * PoE2 Build Companion – main process.
 *
 * Build: from a pasted Path of Building code or from poe.ninja (one request per click on "Refresh").
 * Item check: the hotkey sends exactly ONE copy keystroke to the game and reads the clipboard once
 * (one key press = one action in game); the previous clipboard content is restored. No memory reading,
 * no automation. The clipboard is otherwise only read when the user clicks "Paste build code".
 */

const GAME_TITLE = 'Path of Exile 2';
const DEFAULT_HOTKEY = 'Alt+D';
const MAX_ITEM_TEXT = 20_000;
const MAX_EQUIPS = 30;

const userAgent = () => `poe2-build-companion/${app.getVersion()}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------- Storage ----------

const storeFile = () => join(app.getPath('userData'), 'companion.json');

function sanitizeNinja(v: unknown): NinjaCharacter | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { account, character, league } = v as Record<string, unknown>;
  if (typeof account !== 'string' || typeof character !== 'string' || typeof league !== 'string') return undefined;
  if (!account || !character || !/^[a-z0-9-]+$/.test(league)) return undefined;
  return { account: account.slice(0, 100), character: character.slice(0, 100), league };
}

function sanitizeIcons(v: unknown): ItemIcon[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  return v
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .filter((i) => typeof i.name === 'string' && typeof i.inventoryId === 'string' && typeof i.url === 'string' && i.url.startsWith('https://web.poecdn.com/'))
    .slice(0, 100)
    .map((i) => ({
      name: i.name as string,
      ...(typeof i.base === 'string' ? { base: i.base } : {}),
      ...(i.unique === true ? { unique: true } : {}),
      inventoryId: i.inventoryId as string,
      url: i.url as string,
      x: num(i.x),
      w: num(i.w),
      h: num(i.h),
    }));
}

function sanitizeEquips(v: unknown): EquipRecord[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .filter((e) => typeof e.slot === 'string' && typeof e.itemText === 'string' && typeof e.name === 'string' && typeof e.at === 'string')
    .filter((e) => (e.itemText as string).length <= MAX_ITEM_TEXT)
    .slice(-MAX_EQUIPS)
    .map((e) => ({ slot: (e.slot as string).slice(0, 40), itemText: e.itemText as string, name: (e.name as string).slice(0, 200), at: e.at as string }));
  return list.length ? list : undefined;
}

function sanitizeBuild(v: unknown): StoredBuild | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, unknown>;
  const code = typeof b.code === 'string' ? normalizeBuildCode(b.code) : null;
  if (!code || typeof b.importedAt !== 'string') return undefined;
  const src = b.source as Record<string, unknown> | undefined;
  let source: BuildSource = { kind: 'paste' };
  if (src?.kind === 'ninja') {
    const n = sanitizeNinja(src);
    if (n) source = { kind: 'ninja', ...n };
  } else if (src?.kind === 'file' && typeof src.path === 'string' && /\.xml$/i.test(src.path) && typeof src.name === 'string') {
    source = { kind: 'file', path: src.path, name: src.name.slice(0, 200) };
  }
  const icons = sanitizeIcons(b.icons);
  const equips = sanitizeEquips(b.equips);
  return {
    code,
    source,
    importedAt: b.importedAt,
    ...(typeof b.snapshotAt === 'string' ? { snapshotAt: b.snapshotAt } : {}),
    ...(source.kind === 'ninja' && typeof b.leagueName === 'string' ? { leagueName: b.leagueName.slice(0, 80) } : {}),
    ...(icons ? { icons } : {}),
    ...(equips ? { equips } : {}),
  };
}

function sanitizeSettings(v: unknown): Settings {
  const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const hotkey = typeof s.hotkey === 'string' && !validateHotkey(s.hotkey) ? s.hotkey : DEFAULT_HOTKEY;
  const pos = s.overlayPosition as Record<string, unknown> | undefined;
  const overlayPosition =
    pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: Math.round(pos.x as number), y: Math.round(pos.y as number) } : undefined;
  return { ninja: sanitizeNinja(s.ninja), hotkey, ...(overlayPosition ? { overlayPosition } : {}), ...(s.mcp === true ? { mcp: true } : {}) };
}

function sanitizeTarget(v: unknown): StoredTarget | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const t = v as Record<string, unknown>;
  const code = typeof t.code === 'string' ? normalizeBuildCode(t.code) : null;
  if (!code || typeof t.name !== 'string' || typeof t.importedAt !== 'string') return undefined;
  const source = t.source === 'file' || t.source === 'link' ? t.source : 'paste';
  const link = source === 'link' && typeof t.link === 'string' ? t.link.slice(0, 500) : undefined;
  return { code, name: t.name.slice(0, 200), source, ...(link ? { link } : {}), importedAt: t.importedAt };
}

function loadStore(): StoredState {
  try {
    const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as Partial<StoredState>;
    return { build: sanitizeBuild(raw.build), target: sanitizeTarget(raw.target), settings: sanitizeSettings(raw.settings) };
  } catch {
    return { settings: sanitizeSettings(undefined) };
  }
}

let store: StoredState = { settings: { hotkey: DEFAULT_HOTKEY } };

/** What the app itself wrote last – to tell its own saves from changes by the MCP server. */
let lastWritten = '';

function saveStore() {
  // Write to a temp file first so a crash never leaves a half-written file.
  const file = storeFile();
  lastWritten = JSON.stringify(store, null, 2);
  writeFileSync(`${file}.tmp`, lastWritten);
  renameSync(`${file}.tmp`, file);
}

/**
 * The AI assistant (MCP server) switched the build or equipped an item: load it like the app would.
 */
async function takeOverBuild(disk: StoredBuild | undefined) {
  const cur = store.build;
  if (!disk || !cur) return;
  const same = (a: StoredBuild, b: StoredBuild) => JSON.stringify({ c: a.code, s: a.source }) === JSON.stringify({ c: b.code, s: b.source });
  try {
    if (!same(disk, cur)) {
      if (disk.source.kind === 'file') {
        const res = await loadFromFile(disk.source.path);
        if (res.ok) notify(`Your AI assistant switched to the build "${disk.source.name}".`);
      }
      return;
    }
    if (JSON.stringify(disk.equips ?? []) === JSON.stringify(cur.equips ?? [])) return;
    cur.equips = disk.equips;
    overview = await calculate(cur.code, cur.equips);
    pushView();
    const last = disk.equips?.at(-1);
    if (last) notify(`Your AI assistant equipped ${last.name} in ${last.slot}.`);
  } catch (err) {
    log(`change from the AI connection could not be loaded: ${message(err)}`);
  }
}

/**
 * The MCP server (started by an AI assistant) may set the target build in the same file. Take over such a
 * change right away, so the next save of the app does not undo it. Once a second – a tiny file.
 */
function watchStoreFile() {
  watchFile(storeFile(), { interval: 1000 }, () => {
    let text: string;
    try {
      text = readFileSync(storeFile(), 'utf8');
    } catch {
      return;
    }
    if (text === lastWritten) return;
    try {
      const disk = JSON.parse(text) as Partial<StoredState>;
      lastWritten = text;
      const target = sanitizeTarget(disk.target);
      if (JSON.stringify(target) !== JSON.stringify(store.target)) {
        store.target = target;
        targetCache = null;
        log(`target build changed outside the app (${target ? target.name : 'removed'})`);
        pushView();
        if (target) notify(`Your AI assistant set the target build: ${target.name}`);
      }
      void takeOverBuild(sanitizeBuild(disk.build));
    } catch {
      // halb geschrieben – beim nächsten Mal
    }
  });
}

// ---------- Engine ----------

function pobDir(): string {
  // Packaged: shipped as extra resource. Development: the git submodule.
  const packaged = join(process.resourcesPath, 'pob');
  return app.isPackaged && existsSync(packaged) ? packaged : join(__dirname, '..', 'vendor', 'PathOfBuilding-PoE2');
}

/** Command line an AI client uses to start the MCP server: this exe in Node mode with dist/mcp.js. */
function mcpSetup(): McpSetup {
  const script = app.isPackaged ? join(process.resourcesPath, 'app.asar', 'dist', 'mcp.js') : join(__dirname, 'mcp.js');
  const command = process.execPath;
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  const json = JSON.stringify({ mcpServers: { 'poe2-build-companion': { command, args: [script], env } } }, null, 2);
  const q = (p: string) => `"${p}"`;
  return { command, args: [script], env, json, claudeCode: `claude mcp add poe2-build-companion --env ELECTRON_RUN_AS_NODE=1 -- ${q(command)} ${q(script)}` };
}

const engine = new Engine(join(__dirname, 'engine.js'), pobDir(), log);
let engineState: BuildView['engine'] = 'starting';
let engineError: string | undefined;
let overview: Overview | undefined;
let loadMs: number | undefined;
let hotkeyActive = false;

// ---------- Target build ----------

/** Parsed target build (cached; parsing is fast but happens on every view). */
let targetCache: { code: string; build: TargetBuild } | null = null;

function targetBuild(): TargetBuild | null {
  const t = store.target;
  if (!t) return null;
  if (targetCache?.code !== t.code) {
    try {
      targetCache = { code: t.code, build: parseTargetBuild(decodeBuildCode(t.code)) };
    } catch (err) {
      log(`target build could not be read: ${message(err)}`);
      return null;
    }
  }
  return targetCache.build;
}

function targetView(): TargetView | undefined {
  const t = store.target;
  const build = targetBuild();
  return t && build ? { name: t.name, source: t.source, ...(t.link ? { link: t.link } : {}), importedAt: t.importedAt, build } : undefined;
}

/** Sets the target build from an XML text. Throws with a user-facing message. */
function setTarget(xml: string, name: string, source: 'paste' | 'file' | 'link', link?: string) {
  const { target, build } = makeTarget(xml, name, source, link);
  store.target = target;
  targetCache = { code: target.code, build };
  saveStore();
  pushView();
}


function view(): BuildView {
  return { build: store.build, settings: store.settings, overview, engine: engineState, engineError, loadMs, hotkeyActive, target: targetView(), update: updateState() };
}

let mainWin: BrowserWindow | null = null;
const pushView = () => mainWin?.webContents.send('view:changed', view());

/** Calculates a build code in PoB, with the locally equipped items on top. Throws with a user-facing message. */
async function calculate(code: string, equips: EquipRecord[] = []): Promise<Overview> {
  const xml = decodeBuildCode(code);
  const { result, ms } = await engine.request<Overview & { equips?: ({ ok: true } | { error: string })[] }>('load', {
    xml,
    equips: equips.map((e) => ({ slot: e.slot, itemText: e.itemText })),
  });
  loadMs = ms;
  result.equips?.forEach((r, i) => {
    if ('error' in r) log(`saved item "${equips[i].name}" could not be equipped: ${r.error}`);
  });
  log(`build loaded in ${ms} ms (${equips.length} local items)`);
  return result;
}

async function setBuild(code: string, source: BuildSource, extra: Pick<StoredBuild, 'snapshotAt' | 'icons' | 'leagueName' | 'equips'> = {}) {
  const ov = await calculate(code, extra.equips);
  if (source.kind !== 'file') stopWatchingFile();
  overview = ov;
  store.build = { code, source, importedAt: new Date().toISOString(), ...extra };
  if (!store.build.equips?.length) delete store.build.equips;
  saveStore();
  pushView();
}

type Result = { ok: true; view: BuildView } | { ok: false; error: string; view: BuildView };
const ok = (): Result => ({ ok: true, view: view() });
const fail = (err: unknown): Result => ({ ok: false, error: message(err), view: view() });

async function refreshFromNinja(): Promise<Result> {
  const ninja = store.settings.ninja;
  if (!ninja) return fail('Add your poe.ninja character link first.');
  try {
    const nb = await fetchNinjaBuild(ninja, userAgent());
    const code = normalizeBuildCode(nb.code);
    if (!code) throw new Error('poe.ninja returned an invalid build code.');
    // Items equipped here after poe.ninja's last check are not in its data yet – keep them on top.
    const checked = nb.checkedAt ? Date.parse(nb.checkedAt) : NaN;
    const same = store.build?.source.kind === 'ninja' && store.build.source.character === ninja.character && store.build.source.account === ninja.account;
    const equips = same && Number.isFinite(checked) ? (store.build?.equips ?? []).filter((e) => Date.parse(e.at) > checked) : [];
    if (nb.icons) iconCache = { key: `${ninja.account}/${ninja.league}/${ninja.character}`, at: Date.now(), icons: nb.icons };
    await setBuild(code, { kind: 'ninja', ...ninja }, { snapshotAt: nb.checkedAt, icons: nb.icons, leagueName: nb.leagueName, equips });
    return ok();
  } catch (err) {
    log(`ninja refresh failed: ${message(err)}`);
    return fail(err);
  }
}

// ---------- Item pictures for builds from a file or code ----------

/** Pictures come from the linked poe.ninja profile; at most one request every 10 minutes. */
let iconCache: { key: string; at: number; icons: ItemIcon[] } | null = null;
const ICON_CACHE_MS = 10 * 60_000;

async function profileIcons(): Promise<ItemIcon[] | undefined> {
  const ninja = store.settings.ninja;
  if (!ninja) return undefined;
  const key = `${ninja.account}/${ninja.league}/${ninja.character}`;
  if (iconCache?.key === key && Date.now() - iconCache.at < ICON_CACHE_MS) return iconCache.icons;
  try {
    const icons = await fetchNinjaIcons(ninja, userAgent());
    iconCache = { key, at: Date.now(), icons };
    return icons;
  } catch (err) {
    log(`item pictures from poe.ninja not available: ${message(err)}`);
    // Keep showing the pictures we had rather than none.
    return iconCache?.key === key ? iconCache.icons : store.build?.icons;
  }
}

// ---------- Path of Building build file ----------

/** PoB 2's build folder (tests point it elsewhere). */
const buildsDir = () => process.env.COMPANION_POB_BUILDS ?? findBuildsDir(app.getPath('documents'));

let stopFileWatch: (() => void) | null = null;

/** Loads a build file saved by PoB 2 and keeps watching it. */
async function loadFromFile(path: string): Promise<Result> {
  try {
    const { xml, mtime } = readBuildFile(path);
    const code = normalizeBuildCode(encodeBuildCode(xml));
    if (!code) throw new Error('This build file is too large.');
    const name = basename(path).replace(/\.xml$/i, '');
    // Items equipped here after PoB last saved the file are not in it – keep them on top.
    const same = store.build?.source.kind === 'file' && store.build.source.path === path;
    const equips = same ? (store.build?.equips ?? []).filter((e) => Date.parse(e.at) > mtime) : [];
    await setBuild(code, { kind: 'file', path, name }, { snapshotAt: new Date(mtime).toISOString(), equips, icons: await profileIcons() });
    startFileWatch(path);
    return ok();
  } catch (err) {
    log(`build file ${path} could not be loaded: ${message(err)}`);
    return fail(err);
  }
}

function startFileWatch(path: string) {
  stopFileWatch?.();
  stopFileWatch = watchBuildFile(path, () => void reloadFile(path));
}

function stopWatchingFile() {
  stopFileWatch?.();
  stopFileWatch = null;
}

/** PoB saved the file: reload. PoB writes in place, so retry once if it was caught mid-save. */
async function reloadFile(path: string, retry = true) {
  if (store.build?.source.kind !== 'file' || store.build.source.path !== path) return;
  const res = await loadFromFile(path);
  if (res.ok) {
    notify(`Reloaded – ${basename(path).replace(/\.xml$/i, '')} was saved in Path of Building.`);
  } else if (retry) {
    setTimeout(() => void reloadFile(path, false), 1000);
  } else {
    notify(res.error, 'error');
  }
}

function notify(text: string, kind: 'ok' | 'error' = 'ok') {
  mainWin?.webContents.send('notice', { text, kind });
}

// ---------- Item check ----------

const overlay = new Overlay({
  gameTitle: GAME_TITLE,
  getPosition: () => store.settings.overlayPosition,
  savePosition: (p) => {
    store.settings.overlayPosition = p;
    saveStore();
  },
});

let checkBusy = false;
let lastItemText: string | null = null;
let lastContent: OverlayContent | null = null;

function showOverlay(content: OverlayContent) {
  lastContent = content;
  overlay.show(content);
}

const looksLikeItem = (text: string) => text.length <= MAX_ITEM_TEXT && /^(Item Class|Rarity):/m.test(text);

function ownWindowInFront(): boolean {
  const fg = foregroundWindowHandle();
  if (!fg) return false;
  return overlay.isOwnWindow(fg) || (!!mainWin && !mainWin.isDestroyed() && mainWin.getNativeWindowHandle().readBigUInt64LE(0) === fg);
}

/**
 * Game in front: send ONE copy keystroke, wait for the item text, restore the previous clipboard.
 * Game not in front (e.g. testing with an item copied by hand): read the current clipboard once.
 * The logic lives in @poe2/core (shared with PoE2 Price Check).
 */
function readItemText(): Promise<string> {
  return readGameItemText({ gameTitle: GAME_TITLE, isOwnWindowInFront: ownWindowInFront, log });
}

async function itemCheck(textOverride?: string) {
  if (checkBusy) return; // one key press = one check
  checkBusy = true;
  try {
    const text = textOverride ?? (await readItemText());
    if (!looksLikeItem(text)) {
      showOverlay({ kind: 'error', message: 'No item in the clipboard. Hover over an item in game and press the hotkey again.' });
      return;
    }
    if (!overview) {
      showOverlay({ kind: 'error', message: 'No build loaded yet. Open the Build Companion and load your character first.' });
      return;
    }
    let res: { result: Comparison; ms: number };
    try {
      res = await engine.request<Comparison>('compare', { itemText: text });
    } catch (err) {
      // Currency, gems, maps …: PoB has no item base for them.
      const cls = text.match(/^Item Class: (.+)$/m)?.[1]?.trim();
      if (/does not know this item base/.test(message(err))) {
        showOverlay({ kind: 'error', message: `Only equipment can be checked${cls ? ` – this is ${/^[aeiou]/i.test(cls) ? 'an' : 'a'} ${cls.replace(/s$/, '').toLowerCase()}` : ''}.` });
        return;
      }
      throw err;
    }
    const { result, ms } = res;
    if (result.slots.length === 0) {
      showOverlay({ kind: 'error', message: `${result.item.title ?? result.item.base} does not go into any of your equipment slots.` });
      return;
    }
    lastItemText = text;
    // Für die KI-Verbindung (get_last_item_check): nur der Itemtext und die Zeit, nur auf diesem PC.
    if (store.settings.mcp) {
      try {
        writeFileSync(join(app.getPath('userData'), 'last-item.json'), JSON.stringify({ text, at: new Date().toISOString() }));
      } catch {
        // nicht wichtig
      }
    }
    const verdicts = judgeItem(result.before, result.slots);
    // "Does it fit my build?" – checked against the target build, if one is set.
    const target = targetBuild();
    const fits: Record<string, Fit> = {};
    if (target) {
      for (const v of verdicts) {
        const fit = fitForSlot(target, v.slot, result.item);
        if (fit) fits[v.slot] = fit;
      }
    }
    showOverlay({
      kind: 'check',
      item: result.item,
      verdicts,
      mainSkill: overview.mainSkill,
      ms,
      ...(target ? { fits, targetName: store.target?.name } : {}),
    });
    log(`item check: ${result.item.name} in ${ms} ms`);
  } catch (err) {
    log(`item check failed: ${message(err)}`);
    showOverlay({ kind: 'error', message: message(err) });
  } finally {
    checkBusy = false;
  }
}

/** "Equip in my build": puts the last checked item into the slot of the local build copy. */
async function equipLast(slot: string): Promise<{ ok: boolean; error?: string }> {
  if (!lastItemText || !store.build) return { ok: false, error: 'Nothing to equip.' };
  try {
    const { result } = await engine.request<Overview>('equip', { slot, itemText: lastItemText });
    overview = result;
    const name = result.gear.find((g) => g.slot === slot)?.item?.name ?? slot;
    const equips = (store.build.equips ?? []).filter((e) => e.slot !== slot);
    equips.push({ slot, itemText: lastItemText, name, at: new Date().toISOString() });
    store.build.equips = equips.slice(-MAX_EQUIPS);
    saveStore();
    pushView();
    if (lastContent?.kind === 'check') showOverlay({ ...lastContent, equipped: slot });
    log(`equipped ${name} in ${slot}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

// ---------- Hotkey ----------

function registerHotkey() {
  globalShortcut.unregisterAll();
  try {
    hotkeyActive = globalShortcut.register(store.settings.hotkey, () => void itemCheck());
  } catch {
    hotkeyActive = false;
  }
  if (!hotkeyActive) log(`hotkey ${store.settings.hotkey} could not be registered (used by another program?)`);
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('view:get', () => view());

  ipcMain.handle('upgrades:get', () => upgradeRun);
  ipcMain.handle('upgrades:start', (_e, req: unknown) => startUpgradeSearch(req));
  ipcMain.on('upgrades:cancel', () => {
    upgradeCancel = true;
  });

  // Reads the clipboard exactly once, when the user clicks the button.
  ipcMain.handle('build:paste', async (): Promise<Result> => {
    const text = (await clipboard.readText()).slice(0, MAX_CODE_LENGTH + 1000);
    const code = normalizeBuildCode(text);
    if (!code) return fail('The clipboard does not contain a Path of Building code.');
    try {
      await setBuild(code, { kind: 'paste' }, { icons: await profileIcons() }); // a new code is the newest state: local items are dropped
      return ok();
    } catch (err) {
      return fail(err);
    }
  });

  // Writes the current build code to the clipboard (for Path of Building), on click only.
  ipcMain.handle('build:copy', () => {
    if (!store.build) return false;
    clipboard.writeText(store.build.code);
    return true;
  });

  // Undo all "Equip in my build" changes.
  ipcMain.handle('build:reset-equips', async (): Promise<Result> => {
    if (!store.build) return ok();
    try {
      delete store.build.equips;
      overview = await calculate(store.build.code);
      saveStore();
      pushView();
      return ok();
    } catch (err) {
      return fail(err);
    }
  });

  ipcMain.handle('ninja:set', async (_e, link: unknown): Promise<Result> => {
    const c = typeof link === 'string' ? parseCharacterLink(link) : null;
    if (!c) return fail('That is not a poe.ninja character link. Open your character on poe.ninja and copy the address from the browser.');
    store.settings.ninja = c;
    saveStore();
    return refreshFromNinja();
  });

  ipcMain.handle('ninja:clear', (): Result => {
    delete store.settings.ninja;
    saveStore();
    return ok();
  });

  ipcMain.handle('ninja:refresh', () => refreshFromNinja());

  ipcMain.handle('ninja:open', () => {
    if (store.settings.ninja) void shell.openExternal(characterLink(store.settings.ninja));
  });

  // Target build: from a pasted code (clipboard read once, on click) or a PoB 2 file.
  ipcMain.handle('target:paste', async (): Promise<Result> => {
    const code = normalizeBuildCode((await clipboard.readText()).slice(0, MAX_CODE_LENGTH + 1000));
    if (!code) return fail('The clipboard does not contain a Path of Building code.');
    try {
      const xml = decodeBuildCode(code);
      setTarget(xml, targetName(parseTargetBuild(xml)), 'paste');
      return ok();
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle('target:link', async (_e, link: unknown): Promise<Result> => {
    if (typeof link !== 'string' || !link.trim()) return fail('Paste a link first.');
    try {
      const found = await buildFromLink(link.slice(0, 2000), userAgent());
      const xml = decodeBuildCode(found.code);
      setTarget(xml, `${targetName(parseTargetBuild(xml))} · ${found.origin}`, 'link', link.trim());
      log(`target build from link (${found.origin})`);
      return ok();
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle('target:use-file', (_e, path: unknown): Result => {
    if (typeof path !== 'string') return fail('Invalid file.');
    try {
      setTarget(readBuildFile(path).xml, basename(path).replace(/\.xml$/i, ''), 'file');
      return ok();
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle('target:clear', (): Result => {
    delete store.target;
    targetCache = null;
    saveStore();
    pushView();
    return ok();
  });

  ipcMain.handle('pobfile:list', (): { dir: string; files: PobFileEntry[] } => {
    const dir = buildsDir();
    const files = listBuildFiles(dir).map((f) => ({
      path: f.path,
      name: f.name,
      savedAt: new Date(f.mtime).toISOString(),
      ...(f.level ? { level: f.level } : {}),
      ...(f.className ? { className: f.className } : {}),
    }));
    return { dir, files };
  });
  ipcMain.handle('pobfile:use', (_e, path: unknown) => (typeof path === 'string' ? loadFromFile(path) : fail('Invalid file.')));
  ipcMain.handle('pobfile:choose', async (): Promise<Result | null> => {
    if (!mainWin) return null;
    const res = await dialog.showOpenDialog(mainWin, {
      title: 'Choose a Path of Building 2 build',
      defaultPath: buildsDir(),
      filters: [{ name: 'Path of Building build', extensions: ['xml'] }],
      properties: ['openFile'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return loadFromFile(res.filePaths[0]);
  });
  ipcMain.handle('pobfile:open-folder', () => void shell.openPath(buildsDir()));

  ipcMain.handle('settings:hotkey', (_e, acc: unknown): Result => {
    if (typeof acc !== 'string') return fail('Invalid hotkey.');
    const problem = validateHotkey(acc);
    if (problem) return fail(problem);
    const previous = store.settings.hotkey;
    store.settings.hotkey = acc;
    registerHotkey();
    if (!hotkeyActive) {
      store.settings.hotkey = previous;
      registerHotkey();
      return fail(`${acc} is already used by another program.`);
    }
    saveStore();
    pushView();
    return ok();
  });

  // Optionale KI-Verbindung (MCP): an/aus, und wie ein KI-Programm den Server startet.
  ipcMain.handle('mcp:set', (_e, on: unknown): Result => {
    if (on === true) store.settings.mcp = true;
    else delete store.settings.mcp;
    saveStore();
    pushView();
    log(`AI connection (MCP) ${on === true ? 'on' : 'off'}`);
    return ok();
  });
  ipcMain.handle('mcp:setup', () => mcpSetup());
  // Updates über GitHub-Releases (wie Price Check): erst nach Bestätigung laden, beim Beenden installieren.
  ipcMain.on('update:check', () => void checkForUpdates());
  ipcMain.on('update:download', () => downloadUpdate());
  ipcMain.on('update:install', () => installUpdate());
  ipcMain.on('update:open', () => openReleasePage());
  ipcMain.handle('mcp:copy', (_e, what: unknown) => {
    const s = mcpSetup();
    clipboard.writeText(what === 'claudeCode' ? s.claudeCode : s.json);
    return true;
  });

  ipcMain.handle('settings:reset-overlay', (): Result => {
    delete store.settings.overlayPosition;
    saveStore();
    return ok();
  });

  // Overlay
  ipcMain.on('overlay:ready', (_e, size: { width: number; height: number }) => overlay.place(size));
  ipcMain.on('overlay:hide', () => overlay.hide());
  ipcMain.on('overlay:focus', () => overlay.focus());
  ipcMain.on('overlay:leave', () => overlay.returnFocus('mouse left the overlay'));
  ipcMain.on('overlay:drag-start', () => overlay.startDrag());
  ipcMain.on('overlay:drag-move', () => overlay.moveDrag());
  ipcMain.on('overlay:drag-end', () => overlay.endDrag());
  ipcMain.handle('overlay:weighted', (_e, slot: unknown, opts: unknown) => (typeof slot === 'string' ? openWeightedSearch(slot, opts) : { ok: false, error: 'Invalid slot.' }));
  ipcMain.handle('overlay:equip', (_e, slot: unknown) => (typeof slot === 'string' ? equipLast(slot) : { ok: false, error: 'Invalid slot.' }));
  ipcMain.on('overlay:open-app', () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  });
}

// ---------- Upgrade search ----------
// Only on the user's click: anonymous trade searches (no login, no POESESSID, no PoB OAuth token),
// within GGG's reported rate limits. Buying stays with the user – the app only links the trade site.

let trade: TradeClient | null = null;
let ratesCache: CurrencyRates | null = null;
const RATES_TTL_MS = 30 * 60_000;
let upgradeRun: UpgradeRun = { running: false, results: [] };
let upgradeCancel = false;

const pushUpgrades = () => mainWin?.webContents.send('upgrades:changed', upgradeRun);

/** The build's league (poe.ninja builds know it), otherwise the current challenge league. */
async function tradeLeague(): Promise<string> {
  if (store.build?.leagueName) return store.build.leagueName;
  return (await fetchLeagues(userAgent()))[0];
}

/** poe.ninja exchange rates of the league, at most one request per 30 minutes. */
async function currentRates(league: string): Promise<CurrencyRates> {
  if (!ratesCache || ratesCache.league !== league || Date.now() - ratesCache.fetchedAt > RATES_TTL_MS) {
    ratesCache = await fetchCurrencyRates(league, userAgent());
  }
  return ratesCache;
}

/**
 * Item check: Path of Building's weighted search for a slot, opened in the browser (the trade site runs it
 * for the signed-in user; the app sends no trade request). Weighting and budget as on the Upgrades page.
 */
async function openWeightedSearch(slot: string, raw: unknown): Promise<{ ok: boolean; error?: string }> {
  if (!(UPGRADE_SLOTS as readonly string[]).includes(slot)) return { ok: false, error: 'No weighted search for this slot.' };
  if (!overview) return { ok: false, error: 'Load your build first.' };
  const o = (raw ?? {}) as Record<string, unknown>;
  const dps = Number.isFinite(Number(o.dpsWeight)) ? Math.min(1, Math.max(0, Number(o.dpsWeight))) : 0.5;
  try {
    const { result } = await engine.request<{ query: TradeQuery }>('upgradeQuery', { slot, dpsWeight: dps, ehpWeight: 1 - dps, instantOnly: o.instantOnly !== false }, 120_000);
    const league = await tradeLeague();
    const budget = Number(o.budget);
    let maxExalted = 0;
    if (Number.isFinite(budget) && budget > 0) {
      maxExalted = o.currency === 'exalted' ? budget : budget * (await currentRates(league)).exaltedPerDivine;
    }
    void shell.openExternal(weightedSearchUrl(league, result.query, maxExalted > 0 ? maxExalted : null));
    log(`weighted search opened for ${slot}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

function sanitizeUpgradeRequest(v: unknown): UpgradeRequest | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const budget = Number(r.budget);
  if (!Number.isFinite(budget) || budget <= 0 || budget > 100_000) return null;
  const slots = Array.isArray(r.slots) ? (UPGRADE_SLOTS as readonly string[]).filter((s) => (r.slots as unknown[]).includes(s)) : [];
  if (slots.length === 0) return null;
  const dpsWeight = Number(r.dpsWeight);
  return {
    budget,
    currency: r.currency === 'exalted' ? 'exalted' : 'divine',
    slots,
    dpsWeight: Number.isFinite(dpsWeight) ? Math.min(1, Math.max(0, dpsWeight)) : 0.5,
    instantOnly: r.instantOnly !== false,
    wornMinimum: r.wornMinimum === true,
  };
}

async function startUpgradeSearch(raw: unknown): Promise<UpgradeRun> {
  if (upgradeRun.running) return upgradeRun;
  const req = sanitizeUpgradeRequest(raw);
  if (!req) return { running: false, results: [], error: 'Enter a budget and pick at least one slot.' };
  const ov = overview;
  if (!ov) return { running: false, results: [], error: 'Load your build first.' };

  upgradeCancel = false;
  upgradeRun = { running: true, results: [] };
  pushUpgrades();
  const started = Date.now();
  try {
    const league = await tradeLeague();
    const rates = await currentRates(league);
    trade ??= new TradeClient(userAgent());
    upgradeRun.league = league;
    upgradeRun.exaltedPerDivine = rates.exaltedPerDivine;
    upgradeRun.budgetExalted = req.currency === 'exalted' ? req.budget : Math.floor(req.budget * rates.exaltedPerDivine);
    pushUpgrades();
    log(`upgrade search: ${req.slots.join(', ')} in ${league}, budget ${req.budget} ${req.currency}`);

    await runUpgradeSearch(req, ov.gear, {
      engine: async (cmd, args) => (await engine.request(cmd, args, 120_000)).result as never,
      trade,
      rates,
      league,
      // A different build is loaded → the numbers would be wrong.
      cancelled: () => upgradeCancel || overview !== ov,
      onProgress: (p) => {
        upgradeRun.progress = p;
        pushUpgrades();
      },
      onSlotDone: (r) => {
        upgradeRun.results.push(r);
        if (r.error) log(`upgrade search ${r.slot}: ${r.error}`);
        pushUpgrades();
      },
    });
    log(`upgrade search done in ${Date.now() - started} ms`);
  } catch (err) {
    if (err instanceof SearchCancelled) upgradeRun.error = overview !== ov ? 'Stopped: a different build was loaded.' : 'Search cancelled.';
    else if (err instanceof RateLimitError) {
      const min = Math.ceil(err.waitMs / 60_000);
      upgradeRun.error = err.fromServer
        ? `The trade site paused searches for about ${min} min – the search stopped here. Try again later.`
        : `The trade site's search limit is used up for about ${min} min – the search stopped here so it is not exceeded. Try again later.`;
      log(`upgrade search: rate limit ${err.fromServer ? 'from the trade site (429)' : 'held back locally'}, ${Math.ceil(err.waitMs / 1000)} s`);
    }
    else upgradeRun.error = message(err);
    log(`upgrade search stopped: ${upgradeRun.error}`);
  } finally {
    upgradeRun.running = false;
    delete upgradeRun.progress;
    pushUpgrades();
  }
  return upgradeRun;
}

// ---------- Window ----------

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'PoE2 Build Companion',
    backgroundColor: '#100e0c',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#100e0c', symbolColor: '#9a8f7c', height: 40 },
    show: false,
    webPreferences: { preload: join(__dirname, 'preload.js') },
  });
  mainWin.removeMenu();
  // Kein weißer Rand nach dem Wechsel auf einen Bildschirm mit anderer Skalierung; dunkler Fensterrand.
  keepWindowFrameClean(mainWin, { frameColor: '#100e0c' });
  void mainWin.loadFile(join(__dirname, 'app.html'));
  mainWin.once('ready-to-show', () => mainWin?.show());
  mainWin.on('closed', () => {
    mainWin = null;
    app.quit();
  });
  // External links open in the default browser, never in the app window.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
}

async function startEngine() {
  try {
    await engine.start();
    engineState = 'ready';
    pushView();
    const b = store.build;
    if (b?.source.kind === 'file') {
      // Saved in PoB while the app was closed? Then load the file, otherwise the stored state.
      let newer = false;
      try {
        newer = readBuildFile(b.source.path).mtime > Date.parse(b.snapshotAt ?? '');
      } catch {
        // file missing or mid-save – use the stored state
      }
      if (newer) {
        const res = await loadFromFile(b.source.path);
        if (!res.ok) engineError = res.error;
      } else {
        startFileWatch(b.source.path);
      }
    }
    if (store.build && !overview) {
      try {
        overview = await calculate(store.build.code, store.build.equips);
      } catch (err) {
        engineError = `Your saved build could not be calculated: ${message(err)}`;
      }
    }
    pushView();
  } catch (err) {
    engineState = 'failed';
    engineError = message(err);
    log(`engine failed: ${engineError}`);
    pushView();
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  });
  void app.whenReady().then(() => {
    store = loadStore();
    try {
      lastWritten = readFileSync(storeFile(), 'utf8');
    } catch {
      // noch keine Datei
    }
    watchStoreFile();
    registerIpc();
    createMainWindow();
    overlay.create();
    void startEngine();
    initUpdates({ userAgent: userAgent(), onChange: pushView });
    if (process.env.COMPANION_TEST) {
      // Invisible tests drive the item check directly – no global hotkey, never sending keys.
      (globalThis as Record<string, unknown>).__companionTest = { itemCheck, equipLast, startUpgradeSearch };
    } else {
      registerHotkey();
    }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    stopWatchingFile();
    unwatchFile(storeFile());
    overlay.destroy();
    engine.stop();
  });
}
