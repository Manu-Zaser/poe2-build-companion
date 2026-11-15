// Phase 0 spike: start PoB headless as a child process, load a build code, print the core stats,
// compare them with the stats poe.ninja's PoB stored in the code, then check a few items and time it.
//
// Usage: node spike/run.mjs [build.code] [item.txt ...]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../price-check/test/fixtures');

const codeFile = process.argv[2] ?? path.join(here, 'fixtures/deadeye.code');
const itemFiles = process.argv.length > 3 ? process.argv.slice(3) : [
  path.join(fixtures, 'rare-bow-morbid-stinger.txt'),
  path.join(fixtures, 'rare-gloves-advanced.txt'),
  path.join(fixtures, 'rare-body-armour-hybrid.txt'),
  path.join(fixtures, 'rare-ring.txt'),
];

/** PoB build code: URL-safe base64 of zlib-compressed XML. */
function decodeBuildCode(code) {
  const b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  return zlib.inflateSync(Buffer.from(b64, 'base64')).toString('utf8');
}

/** The <PlayerStat> values the exporting PoB wrote into the code. */
function storedStats(xml) {
  const res = {};
  for (const m of xml.matchAll(/<PlayerStat stat="([^"]+)" value="([^"]+)"\/>/g)) res[m[1]] = Number(m[2]);
  return res;
}

function startHost() {
  const child = spawn(process.execPath, [path.join(here, 'pob-host.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(d));
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = [];
  lines.on('line', (line) => waiting.shift()?.(JSON.parse(line)));
  const next = () => new Promise((resolve) => waiting.push(resolve));
  return {
    ready: next(),
    send(req) {
      const p = next();
      child.stdin.write(JSON.stringify(req) + '\n');
      return p;
    },
    stop: () => child.stdin.end(),
    stderr: () => Buffer.concat(stderr).toString(),
  };
}

const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(v));

const t0 = performance.now();
const host = startHost();
const ready = await host.ready;
console.log(`PoB ready: ${ready.startupMs} ms inside the host, ${Math.round(performance.now() - t0)} ms incl. process spawn`);

const xml = decodeBuildCode(fs.readFileSync(codeFile, 'utf8'));
const loaded = await host.send({ cmd: 'load', xml, name: path.basename(codeFile) });
if (loaded.error) {
  console.error('Load failed:', loaded.error);
  console.error(host.stderr().slice(-3000));
  process.exit(1);
}
console.log(`\nBuild loaded in ${loaded.ms} ms: level ${loaded.level} ${loaded.ascendancy ?? loaded.className}, main skill ${loaded.mainSkill}`);

console.log('\nEquipped:');
for (const [slot, it] of Object.entries(loaded.equipped).sort()) console.log(`  ${slot.padEnd(16)} ${it.name}`);

// Our numbers vs. the numbers poe.ninja's PoB stored in the code.
const stored = storedStats(xml);
console.log('\nStat                       ours        stored in code   diff');
for (const [k, v] of Object.entries(loaded.stats)) {
  const s = stored[k];
  const diff = typeof s === 'number' && s !== 0 ? `${(((v - s) / s) * 100).toFixed(2)} %` : '';
  console.log(`  ${k.padEnd(24)} ${fmt(v).padStart(12)}   ${fmt(s ?? '-').padStart(14)}   ${diff}`);
}

// Item checks.
for (const file of itemFiles) {
  const itemText = fs.readFileSync(file, 'utf8');
  for (const fullDps of [false, true]) {
    const res = await host.send({ cmd: 'compare', itemText, fullDps });
    if (res.error) {
      console.log(`\n${path.basename(file)}: ${res.error}`);
      break;
    }
    console.log(`\n${path.basename(file)} → ${res.item} (${res.base}) · ${res.ms} ms${fullDps ? ' (with FullDPS)' : ''}`);
    if (fullDps) continue; // timing only; deltas already shown
    for (const s of res.slots) {
      const d = Object.entries(s.delta)
        .filter(([k]) => !k.startsWith('Req'))
        .map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${fmt(v)}`)
        .join(', ');
      console.log(`  instead of ${s.replaces ?? '(empty)'} in ${s.slot}: ${d || 'no change'}`);
    }
  }
}

// Sanity check: an equipped item checked against itself must give no change.
for (const slot of ['Boots', 'Helmet', 'Amulet']) {
  const it = loaded.equipped[slot];
  if (!it) continue;
  const res = await host.send({ cmd: 'compare', itemText: it.raw });
  const own = res.slots?.find((s) => s.slot === slot);
  console.log(`\nSelf-check ${slot} (${it.name}): ${own ? JSON.stringify(own.delta) : res.error ?? 'slot not offered'} · ${res.ms} ms`);
}

host.stop();
