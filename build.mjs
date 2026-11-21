import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'node22' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron', 'koffi'] }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  // Calculation engine: runs as its own process (Electron in Node mode) and hosts Path of Building.
  build({ ...common, entryPoints: ['src/engine/host.ts'], outfile: 'dist/engine.js', platform: 'node', format: 'cjs', external: ['koffi'] }),
  // Optional MCP server for AI clients: also runs as its own process (the app exe in Node mode).
  build({ ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'dist/mcp.js', platform: 'node', format: 'cjs', external: ['koffi'] }),
  build({ ...common, entryPoints: ['src/renderer/app.ts'], outfile: 'dist/app.js', platform: 'browser', format: 'iife', target: 'chrome130' }),
  build({ ...common, entryPoints: ['src/renderer/overlay.ts'], outfile: 'dist/overlay.js', platform: 'browser', format: 'iife', target: 'chrome130' }),
]);

cpSync('src/engine/bridge.lua', 'dist/bridge.lua');
for (const f of ['app.html', 'overlay.html', 'base.css', 'app.css', 'overlay.css']) cpSync(`src/renderer/${f}`, `dist/${f}`);
