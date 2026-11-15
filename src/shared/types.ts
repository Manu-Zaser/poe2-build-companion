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
  mods: ModLine[];
  /** Item text in PoB's format. */
  raw: string;
}

/** PoB output values, keyed by PoB's names (Life, FireResist, CombinedDPS, ...). */
export type Stats = Partial<Record<string, number>>;

export interface SkillDps {
  name: string;
  part?: string;
  dps: number;
  /** The build's selected main skill. */
  main?: boolean;
}

export interface Overview {
  className?: string;
  ascendancy?: string;
  level?: number;
  mainSkill?: string;
  weaponSet: number;
  stats: Stats;
  skills: SkillDps[];
  gear: { slot: string; item: ItemInfo | null }[];
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
