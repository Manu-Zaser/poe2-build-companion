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
  | { kind: 'paste' };

export interface StoredBuild {
  code: string;
  source: BuildSource;
  /** ISO time the code was taken (clipboard paste or poe.ninja fetch). */
  importedAt: string;
  /** ISO time poe.ninja last checked the character (only for poe.ninja). */
  snapshotAt?: string;
  /** League display name from poe.ninja, e.g. "Forbidden Rites". */
  leagueName?: string;
  /** Item pictures from the poe.ninja profile (only for poe.ninja). */
  icons?: ItemIcon[];
}

export interface ItemIcon {
  /** "Title, Base" for rare/unique items, the full name otherwise – matches PoB's item name. */
  name: string;
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
}

export interface StoredState {
  build?: StoredBuild;
  settings: Settings;
}

/** What the renderer gets: stored state plus the calculated overview. */
export interface BuildView {
  build?: StoredBuild;
  settings: Settings;
  overview?: Overview;
  engine: 'starting' | 'ready' | 'failed';
  engineError?: string;
  loadMs?: number;
}
