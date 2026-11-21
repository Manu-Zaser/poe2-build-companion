/**
 * Optional MCP server of the Build Companion: lets an AI client (Claude Desktop/Code, Codex CLI, Gemini CLI,
 * VS Code, LM Studio …) read the player's build and let Path of Building calculate items.
 *
 * Started by the AI client, not by the app: the Build Companion exe in Node mode (ELECTRON_RUN_AS_NODE=1) with
 * this script. Local only (stdio, no network port), read-only, never sends anything to the game or trade site.
 * Works only while "AI connection (MCP)" is turned on in the app's settings – checked on every call.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Engine } from '../main/engine';
import { readBuildFile } from '../main/pobfile';
import { decodeBuildCode } from '../shared/buildcode';
import type { Comparison, Overview, StoredState } from '../shared/types';
import { handleMessage, type ServerInfo, type Tool } from './protocol';
import { characterSummary, comparisonSummary, statsSummary } from './tools';
import { buildFromLink, looksLikeLink } from '../shared/targetlink';
import { makeTarget, targetProgress } from '../shared/targetstore';
import { parseTargetBuild } from '../shared/targets';
import { normalizeBuildCode } from '../shared/buildcode';

const err = (m: string) => process.stderr.write(`[build-companion-mcp] ${m}\n`);

const userData = process.env.COMPANION_USER_DATA || join(process.env.APPDATA ?? '', 'PoE2 Build Companion');
const packaged = __dirname.includes('app.asar');
// Packaged: resources/app.asar/dist/mcp.js → resources/pob. Development: the git submodule.
const pobDir = packaged ? join(__dirname, '..', '..', 'pob') : join(__dirname, '..', 'vendor', 'PathOfBuilding-PoE2');

function version(): string {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

const storeFile = () => join(userData, 'companion.json');

/** Writes the target into the app's file (temp file first); a running app picks the change up by itself. */
function writeTarget(target: StoredState['target']) {
  const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as Record<string, unknown>;
  raw.target = target;
  writeFileSync(`${storeFile()}.mcp.tmp`, JSON.stringify(raw, null, 2));
  renameSync(`${storeFile()}.mcp.tmp`, storeFile());
}

function readStore(): StoredState | null {
  try {
    return JSON.parse(readFileSync(join(userData, 'companion.json'), 'utf8')) as StoredState;
  } catch {
    return null;
  }
}

const engine = new Engine(join(__dirname, 'engine.js'), pobDir, err);
let loaded: { key: string; overview: Overview; source: string } | null = null;

/** The build as the app has it: the watched PoB file when there is one (always fresh), else the stored code. */
function enabledStore(): StoredState {
  const store = readStore();
  if (!store?.settings?.mcp) {
    throw new Error('The AI connection is turned off. The player can turn it on in PoE2 Build Companion → AI connection ("Allow AI assistants to read my build").');
  }
  return store;
}

async function currentBuild(): Promise<{ overview: Overview; source: string }> {
  const store = enabledStore();
  const b = store.build;
  if (!b) throw new Error('No build loaded in PoE2 Build Companion yet. Open the app and load your character first.');
  let xml: string;
  let key: string;
  let source: string;
  if (b.source.kind === 'file' && existsSync(b.source.path)) {
    const file = readBuildFile(b.source.path);
    xml = file.xml;
    key = `${b.source.path}|${file.mtime}`;
    source = `Path of Building file "${b.source.name}"`;
  } else {
    xml = decodeBuildCode(b.code);
    key = b.code;
    source = b.source.kind === 'ninja' ? `poe.ninja character ${b.source.character}` : 'pasted build code';
  }
  const equips = (b.equips ?? []).map((e) => ({ slot: e.slot, itemText: e.itemText }));
  key += `|${JSON.stringify(equips)}`;
  if (loaded?.key !== key) {
    const { result } = await engine.request<Overview>('load', { xml, equips }, 120_000);
    loaded = { key, overview: result, source };
  }
  return loaded;
}

const tools: Tool[] = [
  {
    name: 'get_character',
    title: 'Character and gear',
    description:
      "The player's Path of Exile 2 character as loaded in PoE2 Build Companion: class, ascendancy, level, main skill, every equipped item with its mods, jewels, skill gems and supports, ascendancy and keystone passives.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const b = await currentBuild();
      return characterSummary(b.overview, b.source);
    },
  },
  {
    name: 'get_stats',
    title: 'Calculated stats',
    description:
      'Stats Path of Building calculates for the character: life, energy shield, mana, spirit, evasion, resistances, maximum hits taken, effective health pool, attributes and requirements, DPS of the main skill and the strongest other skills.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => statsSummary((await currentBuild()).overview),
  },
  {
    name: 'evaluate_item',
    title: 'Evaluate an item',
    description:
      'Lets Path of Building compare an item with what the character wears: DPS and effective health change in % for each slot it fits, plus the changed stats (resistances, attributes, life …). Pass the item text as copied in game (Ctrl+C or Ctrl+Alt+C) or from the trade site.',
    inputSchema: {
      type: 'object',
      properties: { item_text: { type: 'string', description: 'The item text, starting with "Item Class:" and "Rarity:".' } },
      required: ['item_text'],
      additionalProperties: false,
    },
    run: async (args) => {
      await currentBuild();
      const text = String(args.item_text);
      if (!/^Item Class:/m.test(text) || !/^Rarity:/m.test(text)) throw new Error('This is not an item text. It must contain the "Item Class:" and "Rarity:" lines.');
      const { result } = await engine.request<Comparison>('compare', { itemText: text }, 60_000);
      return comparisonSummary(result);
    },
  },
  {
    name: 'get_target',
    title: 'Target build and progress',
    description:
      "The build the player follows (set in PoE2 Build Companion, e.g. from a guide) and, slot by slot, which of the target item's stats the player's worn item already has and which are missing. Returns null fields if no target is set.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      const store = enabledStore();
      const t = store.target;
      if (!t) return { target: null, note: 'No target build set. Use set_target_build with a Path of Building code or a link (pobb.in, pastebin, poe.ninja, a page with a PoB code).' };
      const build = parseTargetBuild(decodeBuildCode(t.code));
      const gear = store.build ? (await currentBuild()).overview.gear : [];
      return {
        target: { name: t.name, source: t.source, ...(t.link ? { link: t.link } : {}), setAt: t.importedAt, class: build.className ?? null, ascendancy: build.ascendancy ?? null, level: build.level ?? null },
        slots: targetProgress(build, gear),
      };
    },
  },
  {
    name: 'set_target_build',
    title: 'Set the target build',
    description:
      'Sets the build the player follows in PoE2 Build Companion – replaces the current target. Pass a Path of Building code, or a link: pobb.in, pastebin, a poe.ninja character, or a guide page that contains a PoB code. ' +
      'Pages behind bot checks (e.g. some guide sites) cannot be read – then ask the player for the PoB code. Ask the player before replacing an existing target.',
    writes: true,
    inputSchema: {
      type: 'object',
      properties: {
        code_or_link: { type: 'string', description: 'A Path of Building (PoE2) code, or a link to one.' },
        name: { type: 'string', description: 'Optional name to show, e.g. the guide title.' },
      },
      required: ['code_or_link'],
      additionalProperties: false,
    },
    run: async (args) => {
      enabledStore();
      const input = String(args.code_or_link).trim();
      const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null;
      let made;
      if (looksLikeLink(input)) {
        const found = await buildFromLink(input.slice(0, 2000), `poe2-build-companion-mcp/${version()}`);
        made = makeTarget(decodeBuildCode(found.code), name, 'link', input);
        if (!name) made.target.name = `${made.target.name} · ${found.origin}`;
      } else {
        const code = normalizeBuildCode(input);
        if (!code) throw new Error('This is neither a Path of Building code nor a link.');
        made = makeTarget(decodeBuildCode(code), name, 'paste');
      }
      writeTarget(made.target);
      return { set: true, name: made.target.name, class: made.build.className ?? null, ascendancy: made.build.ascendancy ?? null, level: made.build.level ?? null, slots: made.build.slots.map((s) => s.slot) };
    },
  },
];

const info: ServerInfo = {
  name: 'poe2-build-companion',
  version: version(),
  instructions:
    "Access to the player's Path of Exile 2 build from PoE2 Build Companion. All numbers are calculated by Path of Building. " +
      'Only set_target_build changes something (the target build in the app). ' +
    'Nothing is sent to the game or the trade site; buying stays manual. The first call starts Path of Building and takes a few seconds.',
};

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  void handleMessage(line, info, tools).then((res) => {
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
});
rl.on('close', () => {
  engine.stop();
  process.exit(0);
});
err(`ready (${packaged ? 'packaged' : 'development'}, data in ${userData})`);
