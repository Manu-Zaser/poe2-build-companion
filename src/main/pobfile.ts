import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

/**
 * Build files that Path of Building 2 saves on this computer (Ctrl+S in PoB). Reading them is a local
 * file read – no request to GGG or poe.ninja. PoB keeps its own API access to itself.
 */

export const MAX_BUILD_FILE = 20_000_000;

export interface PobBuildFile {
  path: string;
  /** File name without .xml, as PoB lists it. */
  name: string;
  /** Last saved (ms since epoch). */
  mtime: number;
  level?: number;
  className?: string;
}

/**
 * PoB 2's build folder: "<Documents>/Path of Building (PoE2)/Builds", unless a different folder is
 * set in PoB's options (Settings.xml, attribute buildPath).
 */
export function findBuildsDir(documentsDir: string): string {
  const userDir = join(documentsDir, 'Path of Building (PoE2)');
  try {
    const settings = readFileSync(join(userDir, 'Settings.xml'), 'utf8');
    const custom = settings.match(/\bbuildPath="([^"]+)"/)?.[1];
    if (custom && existsSync(custom)) return custom.replace(/[\\/]+$/, '');
  } catch {
    // no settings yet – default folder
  }
  return join(userDir, 'Builds');
}

/** Reads only the beginning of the file: enough for the <Build> element with level and class. */
function readHead(path: string, bytes = 4096): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function describeBuildHead(head: string): { level?: number; className?: string } | null {
  if (!/<PathOfBuilding2[\s>]/.test(head)) return null;
  const build = head.match(/<Build\s[^>]*>/)?.[0] ?? '';
  const attr = (n: string) => build.match(new RegExp(`\\b${n}="([^"]*)"`))?.[1];
  const level = Number(attr('level'));
  const asc = attr('ascendClassName');
  const cls = asc && asc !== 'None' ? asc : attr('className');
  return { ...(Number.isFinite(level) && level > 0 ? { level } : {}), ...(cls ? { className: cls } : {}) };
}

/** PoE2 builds in the folder and its sub-folders (PoB allows folders), newest first. */
export function listBuildFiles(dir: string, depth = 2): PobBuildFile[] {
  const out: PobBuildFile[] = [];
  const walk = (d: string, level: number) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (level < depth) walk(p, level + 1);
      } else if (e.isFile() && extname(e.name).toLowerCase() === '.xml') {
        try {
          const st = statSync(p);
          if (st.size > MAX_BUILD_FILE) continue;
          const info = describeBuildHead(readHead(p));
          if (!info) continue; // not a PoE2 build
          out.push({ path: p, name: basename(e.name, extname(e.name)), mtime: st.mtimeMs, ...info });
        } catch {
          // unreadable file – skip
        }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Reads a saved build. Throws with a user-facing message. */
export function readBuildFile(path: string): { xml: string; mtime: number } {
  if (extname(path).toLowerCase() !== '.xml') throw new Error('Choose a Path of Building build file (.xml).');
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error('The build file no longer exists. Choose it again on the Build source page.');
  }
  if (st.size > MAX_BUILD_FILE) throw new Error('This file is too large for a build file.');
  const xml = readFileSync(path, 'utf8');
  if (!/<PathOfBuilding2[\s>]/.test(xml)) {
    if (/<PathOfBuilding[\s>]/.test(xml)) throw new Error('This is a Path of Exile 1 build. Choose a build from Path of Building for PoE2.');
    throw new Error('This file is not a Path of Building 2 build.');
  }
  // PoB writes the file in place: right after a save it can still be incomplete.
  if (!/<\/PathOfBuilding2>\s*$/.test(xml)) throw new Error('The build file is incomplete (still being saved?).');
  return { xml, mtime: st.mtimeMs };
}

/**
 * Calls onChange (debounced) whenever PoB saves the file. Watches the folder, because saving may
 * replace the file. Returns a function that stops watching.
 */
export function watchBuildFile(path: string, onChange: () => void, debounceMs = 600): () => void {
  let timer: NodeJS.Timeout | undefined;
  let lastMtime = 0;
  try {
    lastMtime = statSync(path).mtimeMs;
  } catch {
    // file missing for now
  }
  const name = basename(path).toLowerCase();
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dirname(path), (_event, file) => {
      if (file && file.toString().toLowerCase() !== name) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          const m = statSync(path).mtimeMs;
          if (m === lastMtime) return;
          lastMtime = m;
          onChange();
        } catch {
          // file gone (renamed?) – nothing to reload
        }
      }, debounceMs);
    });
    watcher.on('error', () => undefined);
  } catch {
    // folder not watchable – the build is still checked when the app starts
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}
