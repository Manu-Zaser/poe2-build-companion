// Calculation engine process. Runs Path of Building PoE2 headless, using the LuaJIT that PoB ships
// (runtime/lua51.dll), loaded via koffi – no separate luajit.exe needed.
//
// Protocol: one JSON request per line on stdin, one JSON response per line on stdout.
// The first line written is {"ready":true,...} (or {"fatal":"..."}). PoB's console output goes to stderr.
//
// Started by the app as `electron dist/engine.js` with ELECTRON_RUN_AS_NODE=1 and POB_DIR set.

import koffi from 'koffi';
import path from 'node:path';
import readline from 'node:readline';

const pobDir = process.env.POB_DIR;
if (!pobDir) {
  process.stdout.write(JSON.stringify({ fatal: 'POB_DIR is not set' }) + '\n');
  process.exit(1);
}

const LUA_GLOBALSINDEX = -10002;

const lua = koffi.load(path.join(pobDir, 'runtime', 'lua51.dll'));
const luaL_newstate = lua.func('void *luaL_newstate()');
const luaL_openlibs = lua.func('void luaL_openlibs(void *L)');
const luaL_loadfile = lua.func('int luaL_loadfile(void *L, const char *filename)');
const lua_pcall = lua.func('int lua_pcall(void *L, int nargs, int nresults, int errfunc)');
const lua_getfield = lua.func('void lua_getfield(void *L, int idx, const char *k)');
const lua_pushlstring = lua.func('void lua_pushlstring(void *L, const uint8_t *s, size_t len)');
const lua_tolstring = lua.func('const char *lua_tolstring(void *L, int idx, _Out_ size_t *len)');
const lua_settop = lua.func('void lua_settop(void *L, int idx)');

function popString(L: unknown): string {
  const s = lua_tolstring(L, -1, [0]) as string | null;
  lua_settop(L, -2);
  return s ?? '';
}

const t0 = performance.now();
// PoB resolves all its files relative to src/.
process.chdir(path.join(pobDir, 'src'));
const L = luaL_newstate();
luaL_openlibs(L);
// LuaJIT liest mit eigenen Dateifunktionen und kann nicht in das app.asar-Archiv der exe schauen –
// bridge.lua liegt dort deshalb ausgepackt (asarUnpack) in app.asar.unpacked.
const bridgeFile = path.join(__dirname.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'bridge.lua');
if (luaL_loadfile(L, bridgeFile) !== 0 || lua_pcall(L, 0, 0, 0) !== 0) {
  process.stdout.write(JSON.stringify({ fatal: `Path of Building failed to start: ${popString(L)}` }) + '\n');
  process.exit(1);
}

function call(requestJson: string): string {
  lua_getfield(L, LUA_GLOBALSINDEX, '__bridge');
  const buf = Buffer.from(requestJson, 'utf8');
  lua_pushlstring(L, buf, buf.length);
  if (lua_pcall(L, 1, 1, 0) !== 0) return JSON.stringify({ error: popString(L) });
  return popString(L);
}

process.stdout.write(JSON.stringify({ ready: true, startupMs: Math.round(performance.now() - t0) }) + '\n');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  // Each request carries an id; the response is wrapped so the app can match it.
  let id: unknown = null;
  try {
    id = (JSON.parse(line) as { id?: unknown }).id ?? null;
  } catch {
    process.stdout.write(JSON.stringify({ id, error: 'invalid JSON request' }) + '\n');
    return;
  }
  const t = performance.now();
  const result = call(line);
  const ms = Math.round(performance.now() - t);
  process.stdout.write(`{"id":${JSON.stringify(id)},"ms":${ms},"result":${result}}\n`);
});
rl.on('close', () => process.exit(0));
