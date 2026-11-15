import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeBuildCode, MAX_CODE_LENGTH, normalizeBuildCode } from '../shared/buildcode';
import { characterLink, fetchNinjaBuild, parseCharacterLink } from '../shared/ninja';
import type { BuildSource, BuildView, NinjaCharacter, Overview, StoredBuild, StoredState } from '../shared/types';
import { Engine } from './engine';
import { log } from './log';

/**
 * PoE2 Build Companion – main process.
 * Phase 1: character overview. The build comes from a pasted Path of Building code or from
 * poe.ninja (one request per click on "Refresh"). The clipboard is read only when the user
 * clicks "Paste build code" – never in the background. Nothing is sent to the game.
 */

const userAgent = () => `poe2-build-companion/${app.getVersion()}`;

// ---------- Storage ----------

const storeFile = () => join(app.getPath('userData'), 'companion.json');

function sanitizeNinja(v: unknown): NinjaCharacter | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { account, character, league } = v as Record<string, unknown>;
  if (typeof account !== 'string' || typeof character !== 'string' || typeof league !== 'string') return undefined;
  if (!account || !character || !/^[a-z0-9-]+$/.test(league)) return undefined;
  return { account: account.slice(0, 100), character: character.slice(0, 100), league };
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
  }
  return {
    code,
    source,
    importedAt: b.importedAt,
    ...(typeof b.snapshotAt === 'string' ? { snapshotAt: b.snapshotAt } : {}),
  };
}

function loadStore(): StoredState {
  try {
    const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as Partial<StoredState>;
    return { build: sanitizeBuild(raw.build), settings: { ninja: sanitizeNinja(raw.settings?.ninja) } };
  } catch {
    return { settings: {} };
  }
}

let store: StoredState = { settings: {} };

function saveStore() {
  // Write to a temp file first so a crash never leaves a half-written file.
  const file = storeFile();
  writeFileSync(`${file}.tmp`, JSON.stringify(store, null, 2));
  renameSync(`${file}.tmp`, file);
}

// ---------- Engine ----------

function pobDir(): string {
  // Packaged: shipped as extra resource. Development: the git submodule.
  const packaged = join(process.resourcesPath, 'pob');
  return app.isPackaged && existsSync(packaged) ? packaged : join(__dirname, '..', 'vendor', 'PathOfBuilding-PoE2');
}

const engine = new Engine(join(__dirname, 'engine.js'), pobDir());
let engineState: BuildView['engine'] = 'starting';
let engineError: string | undefined;
let overview: Overview | undefined;
let loadMs: number | undefined;

function view(): BuildView {
  return { build: store.build, settings: store.settings, overview, engine: engineState, engineError, loadMs };
}

let mainWin: BrowserWindow | null = null;
const pushView = () => mainWin?.webContents.send('view:changed', view());

/** Calculates a build code in PoB. Throws with a user-facing message. */
async function calculate(code: string): Promise<Overview> {
  const xml = decodeBuildCode(code);
  const { result, ms } = await engine.request<Overview>('load', { xml });
  loadMs = ms;
  log(`build loaded in ${ms} ms`);
  return result;
}

async function setBuild(code: string, source: BuildSource, snapshotAt?: string) {
  const ov = await calculate(code);
  overview = ov;
  store.build = { code, source, importedAt: new Date().toISOString(), ...(snapshotAt ? { snapshotAt } : {}) };
  saveStore();
  pushView();
}

type Result = { ok: true; view: BuildView } | { ok: false; error: string; view: BuildView };
const ok = (): Result => ({ ok: true, view: view() });
const fail = (err: unknown): Result => ({ ok: false, error: err instanceof Error ? err.message : String(err), view: view() });

async function refreshFromNinja(): Promise<Result> {
  const ninja = store.settings.ninja;
  if (!ninja) return fail('Add your poe.ninja character link first.');
  try {
    const nb = await fetchNinjaBuild(ninja, userAgent());
    const code = normalizeBuildCode(nb.code);
    if (!code) throw new Error('poe.ninja returned an invalid build code.');
    await setBuild(code, { kind: 'ninja', ...ninja }, nb.checkedAt);
    return ok();
  } catch (err) {
    log(`ninja refresh failed: ${err instanceof Error ? err.message : err}`);
    return fail(err);
  }
}

function registerIpc() {
  ipcMain.handle('view:get', () => view());

  // Reads the clipboard exactly once, when the user clicks the button.
  ipcMain.handle('build:paste', async (): Promise<Result> => {
    const text = (await clipboard.readText()).slice(0, MAX_CODE_LENGTH + 1000);
    const code = normalizeBuildCode(text);
    if (!code) return fail('The clipboard does not contain a Path of Building code.');
    try {
      await setBuild(code, { kind: 'paste' });
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
    if (store.build) {
      try {
        overview = await calculate(store.build.code);
      } catch (err) {
        engineError = `Your saved build could not be calculated: ${err instanceof Error ? err.message : err}`;
      }
      pushView();
    }
  } catch (err) {
    engineState = 'failed';
    engineError = err instanceof Error ? err.message : String(err);
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
    registerIpc();
    createMainWindow();
    void startEngine();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => engine.stop());
}
