// Checks the calculation engine without the app window: starts dist/engine.js (plain Node), loads a
// build code, prints the overview and compares a few items. Run with `npm run engine-check`.
//
// Usage: node scripts/engine-check.mjs [build.code] [item.txt ...]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.resolve(root, '../price-check/test/fixtures');
const codeFile = process.argv[2] ?? path.join(root, 'test/fixtures/deadeye.code');
const itemFiles = process.argv.length > 3
  ? process.argv.slice(3)
  : ['rare-bow-morbid-stinger.txt', 'rare-gloves-advanced.txt', 'rare-ring.txt'].map((f) => path.join(fixtures, f)).filter((f) => fs.existsSync(f));

const xml = zlib.inflateSync(Buffer.from(fs.readFileSync(codeFile, 'utf8').trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toString();

const child = spawn(process.execPath, [path.join(root, 'dist/engine.js')], {
  env: { ...process.env, POB_DIR: path.join(root, 'vendor/PathOfBuilding-PoE2') },
  stdio: ['pipe', 'pipe', 'ignore'],
});
const lines = readline.createInterface({ input: child.stdout });
const queue = [];
lines.on('line', (l) => queue.shift()?.(JSON.parse(l)));
const next = () => new Promise((r) => queue.push(r));
let id = 0;
const send = (cmd, args = {}) => {
  const p = next();
  child.stdin.write(JSON.stringify({ ...args, id: ++id, cmd }) + '\n');
  return p;
};

const ready = await next();
if (!ready.ready) throw new Error(ready.fatal);
console.log(`engine ready in ${ready.startupMs} ms`);

const load = await send('load', { xml });
if (load.result.error) throw new Error(load.result.error);
const ov = load.result;
console.log(`load: ${load.ms} ms · level ${ov.level} ${ov.ascendancy} · main skill ${ov.mainSkill} · weapon set ${ov.weaponSet}`);
console.log('gear:', ov.gear.map((g) => `${g.slot}=${g.item ? g.item.title ?? g.item.base : '-'}`).join(', '));
console.log('jewels:', ov.jewels.length);
console.log('skills:', ov.skills.map((s) => `${s.main ? '*' : ''}${s.name}${s.part ? ` (${s.part})` : ''} ${Math.round(s.dps)}`).join(', '));
const s = ov.stats;
console.log(`life ${s.Life} es ${s.EnergyShield} ehp ${s.TotalEHP} dps ${s.CombinedDPS}`);
for (const e of ['Fire', 'Cold', 'Lightning', 'Chaos']) console.log(`  ${e}: ${s[e + 'Resist']} (missing ${s['Missing' + e + 'Resist']}, total ${s[e + 'ResistTotal']})`);

for (const f of itemFiles) {
  const res = await send('compare', { itemText: fs.readFileSync(f, 'utf8') });
  if (res.result.error) {
    console.log(`${path.basename(f)}: ${res.result.error}`);
    continue;
  }
  const slots = res.result.slots.map((x) => `${x.slot}: ${Object.keys(x.delta).length} changes`).join('; ');
  console.log(`${path.basename(f)} → ${res.result.item.title ?? res.result.item.base} · ${res.ms} ms · ${slots}`);
}
child.stdin.end();
