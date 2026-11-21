/**
 * Optional MCP server of the Build Companion: lets an AI client (Claude Desktop/Code, Codex CLI, Gemini CLI,
 * VS Code, LM Studio …) read the player's build and let Path of Building calculate items.
 *
 * Started by the AI client, not by the app: the Build Companion exe in Node mode (ELECTRON_RUN_AS_NODE=1) with
 * this script. Local only (stdio, no network port), read-only, never sends anything to the game or trade site.
 * Works only while "AI connection (MCP)" is turned on in the app's settings – checked on every call.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Engine } from '../main/engine';
import { readBuildFile } from '../main/pobfile';
import { decodeBuildCode } from '../shared/buildcode';
import type { Comparison, Overview, StoredState } from '../shared/types';
import { handleMessage, type ServerInfo, type Tool } from './protocol';
import { characterSummary, comparisonSummary, statsSummary } from './tools';

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
async function currentBuild(): Promise<{ overview: Overview; source: string }> {
  const store = readStore();
  if (!store?.settings?.mcp) {
    throw new Error('The AI connection is turned off. The player can turn it on in PoE2 Build Companion → AI connection ("Allow AI assistants to read my build").');
  }
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
];

const info: ServerInfo = {
  name: 'poe2-build-companion',
  version: version(),
  instructions:
    "Read-only access to the player's Path of Exile 2 build from PoE2 Build Companion. All numbers are calculated by Path of Building. " +
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
