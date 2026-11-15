// Runs Path of Building PoE2 headless inside this Node process, using the LuaJIT that PoB ships
// (runtime/lua51.dll), loaded via koffi. No separate luajit.exe is needed.
//
// Run as a child process: one JSON request per line on stdin, one JSON response per line on stdout.
// PoB's own console output goes to stderr.

import koffi from 'koffi';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pobDir = process.env.POB_DIR ?? path.resolve(here, '../vendor/PathOfBuilding-PoE2');

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

function popError(L) {
  const msg = lua_tolstring(L, -1, [0]);
  lua_settop(L, -2);
  return msg;
}

const t0 = performance.now();
// PoB resolves everything relative to src/.
process.chdir(path.join(pobDir, 'src'));
const L = luaL_newstate();
luaL_openlibs(L);
if (luaL_loadfile(L, path.join(here, 'bridge.lua')) !== 0 || lua_pcall(L, 0, 0, 0) !== 0) {
  process.stderr.write(`PoB start failed: ${popError(L)}\n`);
  process.exit(1);
}
const startupMs = Math.round(performance.now() - t0);

function call(requestJson) {
  lua_getfield(L, LUA_GLOBALSINDEX, '__bridge');
  const buf = Buffer.from(requestJson, 'utf8');
  lua_pushlstring(L, buf, buf.length);
  if (lua_pcall(L, 1, 1, 0) !== 0) {
    return JSON.stringify({ error: popError(L) });
  }
  const res = lua_tolstring(L, -1, [0]);
  lua_settop(L, -2);
  return res;
}

process.stdout.write(JSON.stringify({ ready: true, startupMs }) + '\n');

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const t = performance.now();
  const res = call(line);
  const ms = Math.round(performance.now() - t);
  // Splice the timing into the response object.
  process.stdout.write(res.replace(/^\{/, `{"ms":${ms},`) + '\n');
});
