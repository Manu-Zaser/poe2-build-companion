/**
 * Optional MCP server of the Build Companion: lets an AI client (Claude Desktop/Code, Codex CLI, Gemini CLI,
 * VS Code, LM Studio …) read the player's build and let Path of Building calculate items.
 *
 * Started by the AI client, not by the app: the Build Companion exe in Node mode (ELECTRON_RUN_AS_NODE=1) with
 * this script. Local only (stdio, no network port), read-only, never sends anything to the game or trade site.
 * Works only while "AI connection (MCP)" is turned on in the app's settings – checked on every call.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Engine } from '../main/engine';
import { readBuildFile } from '../main/pobfile';
import { decodeBuildCode } from '../shared/buildcode';
import type { Comparison, Overview, StoredState } from '../shared/types';
import { handleMessage, type ServerInfo, type Tool } from './protocol';
import { candidateSummary, changeSummary, characterSummary, comparisonSummary, defenceSummary, skillDetails, statsSummary } from './tools';
import { encodeBuildCode } from '../shared/buildcode';
import { findBuildsDir, listBuildFiles } from '../main/pobfile';
import { UPGRADE_SLOTS } from '../shared/upgrades';
import { runUpgradeSearch } from '../main/upgradesearch';
import { fetchCurrencyRates, fetchLeagues } from '@poe2/core/ninja';
import { RateLimitError, TradeClient } from '@poe2/core/trade';
import { buildPriceIndex, checkPairs, fetchPairs, makeFetchJson, type PriceIndex, type PriceMatch } from '@poe2/core/prices';
import type { EquipRecord, Stats, UpgradeRequest } from '../shared/types';
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

/** Changes one part of the app's file (temp file first); a running app picks the change up by itself. */
function writeStore(change: (raw: Record<string, unknown>) => void) {
  const raw = JSON.parse(readFileSync(storeFile(), 'utf8')) as Record<string, unknown>;
  change(raw);
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
      writeStore((raw) => (raw.target = made.target));
      return { set: true, name: made.target.name, class: made.build.className ?? null, ascendancy: made.build.ascendancy ?? null, level: made.build.level ?? null, slots: made.build.slots.map((s) => s.slot) };
    },
  },
];

// ---------- weitere Werkzeuge ----------

const ua = () => `poe2-build-companion-mcp/${version()}`;
/** Das zuletzt per Hotkey geprüfte Item – die App legt es dafür in last-item.json ab. */
const lastItemFile = () => join(userData, 'last-item.json');

async function leagueName(): Promise<string> {
  const b = readStore()?.build;
  if (b?.leagueName) return b.leagueName;
  return (await fetchLeagues(ua()))[0];
}

let priceCache: { league: string; at: number; index: PriceIndex } | null = null;
async function prices(): Promise<PriceIndex> {
  const league = await leagueName();
  if (!priceCache || priceCache.league !== league || Date.now() - priceCache.at > 60 * 60_000) {
    priceCache = { league, at: Date.now(), index: await buildPriceIndex(makeFetchJson(ua()), league) };
  }
  return priceCache.index;
}

function buildsFolder(): string {
  const b = readStore()?.build;
  if (b?.source.kind === 'file') return dirname(b.source.path);
  return findBuildsDir(join(process.env.USERPROFILE ?? '', 'Documents'));
}

const moreTools: Tool[] = [
  {
    name: 'get_skill_details',
    title: 'Skill details',
    description: "All numbers Path of Building calculates for one damaging skill (hit, crit, speed, projectiles, area …) and its support gems. Without a name: the main skill.",
    inputSchema: { type: 'object', properties: { skill: { type: 'string', description: 'Skill name, e.g. "Ice Shot". Optional.' } }, additionalProperties: false },
    run: async (args) => skillDetails((await currentBuild()).overview, typeof args.skill === 'string' ? args.skill : undefined),
  },
  {
    name: 'get_defence_details',
    title: 'Defence details',
    description: 'Every defensive and recovery number Path of Building calculates: resistances and maximum hit per element, life, energy shield, evasion, deflection, armour, block, regeneration, leech, recharge, movement speed.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => defenceSummary((await currentBuild()).overview),
  },
  {
    name: 'get_last_item_check',
    title: 'Last checked item',
    description: 'The item the player last checked in game with the item check hotkey, compared with the worn gear by Path of Building (DPS and EHP change per slot). Use it when the player asks about "this item" or "the item I just found".',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      await currentBuild();
      let last: { text: string; at: string };
      try {
        last = JSON.parse(readFileSync(lastItemFile(), 'utf8')) as { text: string; at: string };
      } catch {
        throw new Error('No item checked yet. In game, hover over an item and press the item check hotkey of PoE2 Build Companion.');
      }
      const { result } = await engine.request<Comparison>('compare', { itemText: last.text }, 60_000);
      return { checkedAt: last.at, ...comparisonSummary(result) };
    },
  },
  {
    name: 'what_if',
    title: 'What if …',
    description:
      'Lets Path of Building calculate the build with extra modifiers, without changing it – e.g. "+30% to Chaos Resistance", "+1 to Level of all Projectile Skills", "+50 to Spirit", "20% increased Attack Speed". ' +
      'Returns the change in DPS and EHP and every stat that moved. Lines PoB does not understand are listed and not applied.',
    inputSchema: {
      type: 'object',
      properties: { mods: { type: 'array', items: { type: 'string' }, description: 'Modifier lines as they appear on items.' } },
      required: ['mods'],
      additionalProperties: false,
    },
    run: async (args) => {
      await currentBuild();
      const mods = (Array.isArray(args.mods) ? args.mods : [args.mods]).map(String).filter((m) => m.trim()).slice(0, 20);
      if (!mods.length) throw new Error('Give at least one modifier line.');
      const { result } = await engine.request<{ applied: string[]; unknown: string[]; before: Stats; after: Stats }>('whatIf', { mods }, 60_000);
      return { applied: result.applied, ...(result.unknown.length ? { notUnderstood: result.unknown } : {}), ...changeSummary(result.before, result.after) };
    },
  },
  {
    name: 'price_item',
    title: 'Price on poe.ninja',
    description:
      "poe.ninja price of currency, runes, omens, essences, other exchange items or a unique, in the player's league – with the check of all trade pairs (thin markets get a warning or the lower price).",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Item name, e.g. "Divine Orb", "Omen of Whittling", "Headhunter".' } }, required: ['name'], additionalProperties: false },
    run: async (args) => {
      const idx = await prices();
      const q = String(args.name).trim().toLowerCase();
      const describe = (m: PriceMatch, kind: string) => ({
        name: m.name,
        ...(m.baseType ? { base: m.baseType } : {}),
        kind,
        divine: Math.round(m.divine * 1000) / 1000,
        exalted: Math.round(m.exalted * 10) / 10,
        ...(m.change7d !== undefined ? { change7dPct: Math.round(m.change7d * 10) / 10 } : {}),
        ...(m.listingCount !== undefined ? { listings: m.listingCount } : {}),
        ...(m.volumeDivine !== undefined ? { tradedVolumeDivine: Math.round(m.volumeDivine * 10) / 10 } : {}),
        ...(m.warning ? { warning: m.warning } : {}),
      });
      let ex = idx.currency.get(q);
      if (!ex) ex = [...idx.currency.values()].find((m) => m.name.toLowerCase().includes(q));
      if (ex) {
        let checked = ex;
        if (ex.ninjaRef && ex.ninjaRef.id !== 'divine') {
          try {
            checked = checkPairs(ex, await fetchPairs(makeFetchJson(ua()), idx.league, ex.ninjaRef), idx.exaltedPerDivine);
          } catch {
            // ohne Paar-Prüfung bleibt der poe.ninja-Preis
          }
        }
        return { league: idx.league, exaltedPerDivine: idx.exaltedPerDivine, ...describe(checked, 'exchange item') };
      }
      const uniques = idx.uniquesByName.get(q) ?? [...idx.uniquesByName.entries()].find(([k]) => k.includes(q))?.[1];
      if (uniques?.length) {
        return { league: idx.league, exaltedPerDivine: idx.exaltedPerDivine, variants: uniques.slice().sort((a, b) => (b.listingCount ?? 0) - (a.listingCount ?? 0)).slice(0, 5).map((m) => describe(m, 'unique')) };
      }
      throw new Error(`poe.ninja has no price for "${args.name}" in ${idx.league}. Rare items have no fixed price – use search_upgrades or the trade site.`);
    },
  },
  {
    name: 'equip_item',
    title: 'Equip an item in the build',
    description:
      "Puts an item into the build in PoE2 Build Companion (like its \"Equip in my build\"), so further questions use it – e.g. to try several upgrades one after another. Only the app's copy changes, not the game or the PoB file; the next import or \"Reset\" in the app undoes it. Ask the player first.",
    writes: true,
    inputSchema: {
      type: 'object',
      properties: {
        item_text: { type: 'string', description: 'The item text, starting with "Item Class:" and "Rarity:".' },
        slot: { type: 'string', description: 'Slot, e.g. "Ring 2". Needed when the item fits more than one slot.' },
      },
      required: ['item_text'],
      additionalProperties: false,
    },
    run: async (args) => {
      await currentBuild();
      const text = String(args.item_text);
      if (!/^Item Class:/m.test(text) || !/^Rarity:/m.test(text)) throw new Error('This is not an item text. It must contain the "Item Class:" and "Rarity:" lines.');
      const { result } = await engine.request<Comparison>('compare', { itemText: text }, 60_000);
      const slots = result.slots.map((s) => s.slot);
      if (!slots.length) throw new Error('This item does not go into any of the equipment slots.');
      const slot = typeof args.slot === 'string' && args.slot.trim() ? args.slot.trim() : slots.length === 1 ? slots[0] : null;
      if (!slot) throw new Error(`This item fits ${slots.join(' and ')} – say which slot.`);
      if (!slots.includes(slot)) throw new Error(`This item does not fit ${slot}. It fits: ${slots.join(', ')}.`);
      const record: EquipRecord = { slot, itemText: text, name: result.item.title ?? result.item.name, at: new Date().toISOString() };
      writeStore((raw) => {
        const b = raw.build as { equips?: EquipRecord[] } | undefined;
        if (!b) throw new Error('No build loaded.');
        b.equips = [...(b.equips ?? []).filter((e) => e.slot !== slot), record].slice(-30);
      });
      const comp = result.slots.find((s) => s.slot === slot)!;
      return { equipped: record.name, slot, replaced: comp.replaces, ...changeSummary(result.before, comp.after) };
    },
  },
  {
    name: 'list_builds',
    title: 'Saved PoB builds',
    description: 'The builds saved in Path of Building 2 on this computer (name, class, level, last saved) and which one PoE2 Build Companion uses.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async () => {
      enabledStore();
      const store = readStore();
      const inUse = store?.build?.source.kind === 'file' ? store.build.source.path : null;
      const dir = buildsFolder();
      return {
        folder: dir,
        builds: listBuildFiles(dir).map((f) => ({ name: f.name, class: f.className ?? null, level: f.level ?? null, saved: new Date(f.mtime).toISOString(), ...(f.path === inUse ? { inUse: true } : {}) })),
      };
    },
  },
  {
    name: 'use_build',
    title: 'Switch to another saved build',
    description: "Makes PoE2 Build Companion use another build saved in Path of Building 2 (see list_builds) – e.g. a bossing setup. Every save in PoB then reloads it. Ask the player first.",
    writes: true,
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Build name as list_builds shows it.' } }, required: ['name'], additionalProperties: false },
    run: async (args) => {
      enabledStore();
      const want = String(args.name).trim().toLowerCase();
      const files = listBuildFiles(buildsFolder());
      const file = files.find((f) => f.name.toLowerCase() === want) ?? files.find((f) => f.name.toLowerCase().includes(want));
      if (!file) throw new Error(`No saved build called "${args.name}". Saved builds: ${files.map((f) => f.name).join(', ') || 'none'}.`);
      const { xml, mtime } = readBuildFile(file.path);
      const code = normalizeBuildCode(encodeBuildCode(xml));
      if (!code) throw new Error('This build file is too large.');
      writeStore((raw) => {
        raw.build = { code, source: { kind: 'file', path: file.path, name: file.name }, importedAt: new Date().toISOString(), snapshotAt: new Date(mtime).toISOString() };
      });
      loaded = null;
      const b = await currentBuild();
      return { using: file.name, class: b.overview.ascendancy ?? b.overview.className ?? null, level: b.overview.level ?? null, mainSkill: b.overview.mainSkill ?? null };
    },
  },
  {
    name: 'search_upgrades',
    title: 'Search the trade site for upgrades',
    description:
      'Searches the official trade site (anonymously) for items within a budget that beat the worn gear, and lets Path of Building calculate every listing. Returns the best listings per slot with price, DPS/EHP change and a link – buying stays with the player. ' +
      'Takes about 10–30 s per slot; the trade site allows only a few searches per minute, so search at most 3 slots per call and wait a few minutes between big runs.',
    inputSchema: {
      type: 'object',
      properties: {
        slots: { type: 'array', items: { type: 'string', enum: [...UPGRADE_SLOTS] }, description: 'Slots to search, at most 3.' },
        budget: { type: 'number', description: 'Budget per item.' },
        currency: { type: 'string', enum: ['divine', 'exalted'], description: 'Currency of the budget (default divine).' },
        damage_weight: { type: 'number', description: 'How much damage counts vs. defence, 0–1 (default 0.5).' },
        instant_buyout_only: { type: 'boolean', description: 'Only listings with instant buyout (default true).' },
      },
      required: ['slots', 'budget'],
      additionalProperties: false,
    },
    run: async (args) => {
      const { overview } = await currentBuild();
      const slots = (Array.isArray(args.slots) ? args.slots : [args.slots]).map(String).filter((s) => (UPGRADE_SLOTS as readonly string[]).includes(s));
      if (!slots.length) throw new Error(`Pick slots from: ${UPGRADE_SLOTS.join(', ')}.`);
      if (slots.length > 3) throw new Error('At most 3 slots per call – the trade site allows only a few searches per minute.');
      const budget = Number(args.budget);
      if (!(budget > 0)) throw new Error('The budget must be more than 0.');
      const req: UpgradeRequest = {
        budget,
        currency: args.currency === 'exalted' ? 'exalted' : 'divine',
        slots,
        dpsWeight: typeof args.damage_weight === 'number' ? Math.min(1, Math.max(0, args.damage_weight)) : 0.5,
        instantOnly: args.instant_buyout_only !== false,
      };
      const league = await leagueName();
      const rates = await fetchCurrencyRates(league, ua());
      trade ??= new TradeClient(ua());
      try {
        const results = await runUpgradeSearch(req, overview.gear, {
          engine: async (cmd, a) => (await engine.request(cmd, a, 120_000)).result as never,
          trade,
          rates,
          league,
        });
        return {
          league,
          budget: `${req.budget} ${req.currency}`,
          exaltedPerDivine: rates.exaltedPerDivine,
          slots: results.map((r) => ({
            slot: r.slot,
            current: r.current,
            ...(r.error ? { error: r.error } : {}),
            listingsFound: r.total,
            calculated: r.evaluated,
            ...(r.tradeUrl ? { tradeSearch: r.tradeUrl } : {}),
            best: r.candidates.map(candidateSummary),
          })),
        };
      } catch (err) {
        if (err instanceof RateLimitError) throw new Error(`The trade site's search limit is reached – try again in about ${Math.ceil(err.waitMs / 60_000)} min.`);
        throw err;
      }
    },
  },
];
tools.push(...moreTools);
let trade: TradeClient | null = null;

const info: ServerInfo = {
  name: 'poe2-build-companion',
  version: version(),
  instructions:
    "Access to the player's Path of Exile 2 build from PoE2 Build Companion. All numbers are calculated by Path of Building. " +
      'Only set_target_build, equip_item and use_build change something – and only in the app, never in the game. ' +
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
