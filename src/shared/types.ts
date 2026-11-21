// Shapes shared by main process, engine bridge and renderer.

export type Rarity = 'NORMAL' | 'MAGIC' | 'RARE' | 'UNIQUE' | 'RELIC';

export interface ModLine {
  text: string;
  kind: 'enchant' | 'rune' | 'implicit' | 'explicit' | 'unique';
  /** PoB could not parse this line (it has no effect in the calculation). */
  inactive?: boolean;
}

export interface ItemInfo {
  name: string;
  title?: string;
  base: string;
  rarity: Rarity;
  corrupted: boolean;
  quality?: number;
  itemLevel?: number;
  mods: ModLine[];
  /** Item text in PoB's format. */
  raw: string;
}

/** PoB output values, keyed by PoB's names (Life, FireResist, CombinedDPS, ...). */
export type Stats = Partial<Record<string, number>>;

export interface SkillDps {
  /** Index of the skill group in PoB's Skills tab. */
  group: number;
  name: string;
  part?: string;
  dps: number;
  /** Speed, CritChance, CritMultiplier, HitChance, ProjectileCount, AreaOfEffectRadiusMetres, ... */
  stats: Stats;
  /** The build's selected main skill. */
  main?: boolean;
}

export interface Gem {
  name: string;
  level?: number;
  quality?: number;
  support: boolean;
  enabled: boolean;
}

export interface GemGroup {
  index: number;
  label: string | null;
  slot: string | null;
  /** Granted by an item, not socketed by the player. */
  fromItem?: boolean;
  enabled: boolean;
  main?: boolean;
  gems: Gem[];
}

export interface PassiveNode {
  name: string;
  kind: 'ascendancy' | 'keystone';
  lines: string[];
}

export interface Passives {
  points: number;
  weaponSetPoints: number;
  ascendancyPoints: number;
  nodes: PassiveNode[];
}

export interface GearSlot {
  slot: string;
  /** Weapon set (1 or 2) for weapon slots, null for all others. */
  set: number | null;
  item: ItemInfo | null;
}

export interface Overview {
  className?: string;
  ascendancy?: string;
  level?: number;
  mainSkill?: string;
  /** The main skill selected in PoB does no damage, so the skill with the highest DPS is used instead. */
  mainSkillAuto?: boolean;
  weaponSet: number;
  stats: Stats;
  skills: SkillDps[];
  gemGroups: GemGroup[];
  passives: Passives;
  gear: GearSlot[];
  jewels: { slot: string; item: ItemInfo }[];
}

export interface SlotComparison {
  slot: string;
  replaces: string | null;
  after: Stats;
  delta: Stats;
}

export interface Comparison {
  item: ItemInfo;
  before: Stats;
  slots: SlotComparison[];
}

/** Where the current build code came from. */
export type BuildSource =
  | { kind: 'ninja'; account: string; character: string; league: string }
  /** A build file Path of Building 2 saved on this computer; reloaded whenever PoB saves it. */
  | { kind: 'file'; path: string; name: string }
  | { kind: 'paste' };

export interface StoredBuild {
  code: string;
  source: BuildSource;
  /** ISO time the code was taken (clipboard paste or poe.ninja fetch). */
  importedAt: string;
  /** ISO time poe.ninja last checked the character, or when PoB saved the build file. */
  snapshotAt?: string;
  /** League display name from poe.ninja, e.g. "Forbidden Rites". */
  leagueName?: string;
  /** Item pictures from the poe.ninja profile (only for poe.ninja). */
  icons?: ItemIcon[];
  /** Items equipped via "Equip in my build" since the code was taken; applied on every load. */
  equips?: EquipRecord[];
}

export interface EquipRecord {
  slot: string;
  /** Item text as copied in game. */
  itemText: string;
  name: string;
  /** ISO time it was equipped. */
  at: string;
}

export interface ItemIcon {
  /** "Title, Base" for rare/unique items, the full name otherwise – matches PoB's item name. */
  name: string;
  /** Base type, e.g. "Barbed Bracers" – rare and magic items look like their base. */
  base?: string;
  /** true for unique items – their picture is their own, not the base's. */
  unique?: boolean;
  /** Game inventory id: Weapon, Offhand, Weapon2, Offhand2, Helm, BodyArmour, Gloves, Boots, Amulet, Ring, Ring2, Belt, Flask. */
  inventoryId: string;
  /** Position for flasks and charms (0-based). */
  x?: number;
  /** Image on GGG's CDN (https://web.poecdn.com/...). */
  url: string;
  /** Size in inventory cells. */
  w?: number;
  h?: number;
}

export interface NinjaCharacter {
  account: string;
  character: string;
  /** League as used in poe.ninja URLs, e.g. "forbiddenrites". */
  league: string;
}

export interface Settings {
  ninja?: NinjaCharacter;
  /** Item check hotkey (Electron accelerator), e.g. "Alt+D". */
  hotkey: string;
  /** Where the user left the overlay. */
  overlayPosition?: { x: number; y: number };
  /** Optional AI connection: the MCP server (dist/mcp.js) answers only while this is on. */
  mcp?: boolean;
}

/** How an AI client starts the MCP server (shown on the "AI connection" page). */
export interface McpSetup {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Ready to paste into claude_desktop_config.json, .mcp.json and similar files. */
  json: string;
  /** One line for Claude Code. */
  claudeCode: string;
}

export interface StoredState {
  build?: StoredBuild;
  /** The build the player follows (e.g. from a guide). */
  target?: StoredTarget;
  settings: Settings;
}

export interface StoredTarget {
  code: string;
  /** Shown name: the PoB file name, or class and level for a pasted code. */
  name: string;
  source: 'paste' | 'file';
  /** ISO time it was set. */
  importedAt: string;
}

/** Target build as the renderer and overlay get it. */
export interface TargetView {
  name: string;
  source: 'paste' | 'file';
  importedAt: string;
  build: import('./targets').TargetBuild;
}

/** What the renderer gets: stored state plus the calculated overview. */
export interface BuildView {
  build?: StoredBuild;
  settings: Settings;
  overview?: Overview;
  engine: 'starting' | 'ready' | 'failed';
  engineError?: string;
  loadMs?: number;
  /** false if another program already uses the hotkey. */
  hotkeyActive: boolean;
  target?: TargetView;
}

/** A build file saved by Path of Building 2, as listed on the Build source page. */
export interface PobFileEntry {
  path: string;
  name: string;
  /** ISO time it was last saved. */
  savedAt: string;
  level?: number;
  className?: string;
}

/** What the overlay shows. */
export type OverlayContent =
  | {
      kind: 'check';
      item: ItemInfo;
      verdicts: import('./verdict').SlotVerdict[];
      mainSkill?: string;
      ms: number;
      equipped?: string;
      /** Fit with the target build per slot (only with a target build). */
      fits?: Record<string, import('./targets').Fit>;
      targetName?: string;
    }
  | { kind: 'error'; message: string };

// ---------- Upgrade search ----------

/** What the user asks for on the Upgrades page. */
export interface UpgradeRequest {
  /** Budget per item. */
  budget: number;
  currency: 'divine' | 'exalted';
  slots: string[];
  /** Share of DPS in the weighting (0…1); the rest goes to effective HP. */
  dpsWeight: number;
  /** Only listings with instant buyout. */
  instantOnly: boolean;
  /** Each searched stat at least as high as on the worn item. */
  wornMinimum?: boolean;
}

export interface UpgradeCandidate {
  item: ItemInfo;
  /** Listing price as the seller set it, e.g. { amount: 2, currency: 'divine' }. */
  price: { amount: number; currency: string } | null;
  priceDivine: number | null;
  dpsPct: number;
  ehpPct: number;
  /** Weighted gain in %. */
  gain: number;
  upgrade: boolean;
  /** Why the item is ruled out (resistance below cap, attributes, spirit, movement speed). */
  blocking: string[];
  warnings: string[];
  changes: import('./verdict').Change[];
  /** When the listing was put up (ISO). */
  listedAt?: string;
  /** The trade site with this listing on top (same search, this seller). */
  tradeUrl?: string;
  /** Item picture on GGG's CDN. */
  icon?: string;
}

export interface UpgradeSlotResult {
  slot: string;
  /** What the build wears there now. */
  current: string | null;
  /** Matching listings on the trade site. */
  total: number;
  /** How many of them Path of Building calculated. */
  evaluated: number;
  /** Fetched listings left out because they cost more than the budget (the trade site converts prices its own way). */
  overBudget?: number;
  /** Price levels searched (1 = cheapest page only; more for big markets, see PRICE_LEVELS). */
  priceLevels?: number;
  /** The search on the trade site (to buy by hand). */
  tradeUrl?: string;
  /** Path of Building's weighted search within the budget, for the browser (where the user is signed in). */
  weightedUrl?: string;
  /** What was searched for, most valuable first (e.g. "Cold resistance", "x% increased Attack Speed"). */
  searched?: string[];
  /** Best first; at most a handful. */
  candidates: UpgradeCandidate[];
  error?: string;
}

export interface UpgradeProgress {
  slot: string;
  /** 0-based index of the slot and number of slots. */
  index: number;
  count: number;
  step: 'weights' | 'search' | 'fetch' | 'evaluate' | 'wait';
  /** Seconds left while waiting for the trade site's rate limit. */
  waitS?: number;
}

export interface UpgradeRun {
  running: boolean;
  league?: string;
  /** Exalted per Divine used for prices. */
  exaltedPerDivine?: number;
  budgetExalted?: number;
  progress?: UpgradeProgress;
  results: UpgradeSlotResult[];
  error?: string;
}
