/**
 * Upgrade search: which items within a budget are better than what the build wears?
 *
 * 1. Path of Building weighs every mod that can roll on the slot (TradeQueryGenerator, see bridge.lua).
 * 2. Those weights become a short list of stats that matter (searchstats.ts: variants merged into the trade
 *    site's pseudo totals, defence mods only for the base's defences, minor stats left out).
 * 3. A weighted-sum trade search is too complex for anonymous requests, so they become a "count" search:
 *    items within the budget that have at least N of the stats with a decent roll, cheapest first.
 *    (No login, no POESESSID, no PoB OAuth token.)
 * 4. PoB calculates every candidate exactly; the ranking below uses those numbers only.
 */
import type { SearchStat } from './searchstats';
import type { SlotVerdict } from './verdict';

export interface TradeStatFilter {
  id: string;
  value?: { min?: number; max?: number; weight?: number };
}

export interface TradeStatGroup {
  type: string;
  value?: { min?: number; max?: number };
  filters: TradeStatFilter[];
}

/** The search PoB's generator builds (query + sort), or the anonymous one made from it. */
export interface TradeQuery {
  query: {
    status?: { option: string };
    filters?: Record<string, { disabled?: boolean; filters: Record<string, unknown> }>;
    stats: TradeStatGroup[];
    [key: string]: unknown;
  };
  sort: Record<string, string>;
}

/** One mod as weighed by PoB for this slot (most valuable first). */
export interface PobModWeight {
  /** Trade stat id, e.g. "explicit.stat_3299347043". */
  id: string;
  /** Trade stat text, e.g. "#% to Cold Resistance" (null if PoB had none). */
  text?: string | null;
  /** Effect per point of the mod. */
  weight: number;
  /** Effect of the tested roll (PoB's weighted DPS/EHP gain ×1000). */
  effect: number;
  /** The roll PoB tested: middle of the mod's range on this item category. */
  testedValue: number | null;
}

export interface AnonymousQueryOptions {
  /** Budget per item as Exalted equivalent (the trade site's default price unit for PoE2). */
  maxExalted: number;
  /** How many of the stats an item must have. */
  minCount?: number;
  /** A mod only counts with at least this share of PoB's tested (middle) roll. */
  rollShare?: number;
  /** Stats every candidate must have (e.g. movement speed on boots). */
  required?: TradeStatFilter[];
  /** Trade site equipment filters, e.g. { ev: { min: 1 } } to stay on bases with the same defences. */
  equipment?: Record<string, { min: number }> | null;
}

export const DEFAULT_MIN_COUNT = 3;
export const DEFAULT_ROLL_SHARE = 0.7;

/**
 * Searches tried one after another until enough listings match: first strict (4 of the stats with a good
 * roll), then looser (one stat less, 70 % of the roll). Strict first because the cheapest listings of a loose
 * search are mostly junk; at most two searches per slot keep the trade site's search limit in reach.
 */
export const QUERY_STEPS: readonly { minCount: number; rollShare: number }[] = [
  { minCount: 4, rollShare: 1 },
  { minCount: 3, rollShare: 0.7 },
];

/** How many of n stats a step asks for: never all of few stats in the loose step. */
export function countFor(step: { minCount: number }, n: number, loose: boolean): number {
  return Math.max(1, Math.min(step.minCount, loose ? n - 1 : n));
}
/** A step with at least this many results is used as it is. */
export const ENOUGH_RESULTS = 20;
/** Listings fetched and calculated per slot (10 per fetch). */
export const CANDIDATES_PER_SLOT = 30;
/** Of those, the cheapest ones; the rest is spread over the pricier listings up to the budget. */
export const CHEAPEST_CANDIDATES = 10;

/**
 * Which listings to calculate. The search returns up to 100 ids sorted by price; the cheapest barely meet
 * the minimum rolls, the better items cost more. So: the cheapest few plus an even spread over the rest.
 */
export function pickCandidates(ids: string[], count = CANDIDATES_PER_SLOT, cheapest = CHEAPEST_CANDIDATES): string[] {
  if (ids.length <= count) return [...ids];
  const head = ids.slice(0, cheapest);
  const rest = ids.slice(cheapest);
  const n = count - head.length;
  const picked = Array.from({ length: n }, (_, i) => rest[Math.round(((i + 1) * rest.length) / n) - 1]);
  return [...head, ...picked];
}

/** Slots the upgrade search covers (the equipment slots PoB's trade search supports). */
export const UPGRADE_SLOTS = ['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt'] as const;

/**
 * The trade site's page with one listing on top: the same search, limited to the seller and the item's base type.
 * The page runs the search itself from ?q=… – that costs no request from this app.
 */
export function listingUrl(league: string, query: TradeQuery, seller: string, baseType?: string): string {
  const q = structuredClone(query);
  if (baseType) q.query.type = baseType;
  const trade = q.query.filters?.trade_filters?.filters ?? {};
  q.query.filters = { ...q.query.filters, trade_filters: { filters: { ...trade, account: { input: seller } } } };
  return `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}?q=${encodeURIComponent(JSON.stringify(q))}`;
}

/** The trade site's page for a search, to look at and buy by hand. */
export function tradeSearchUrl(league: string, queryId: string): string {
  return `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}/${encodeURIComponent(queryId)}`;
}

/** Movement speed from all sources – the trade site's own pseudo stat. */
export const MOVEMENT_SPEED_STAT = 'pseudo.pseudo_increased_movement_speed';

/** "+x%"/"x% increased Movement Speed" on an item's mod lines (0 if none). */
export function movementSpeedOf(modTexts: string[]): number {
  let total = 0;
  for (const t of modTexts) {
    const m = t.match(/^(\d+(?:\.\d+)?)% increased Movement Speed$/i);
    if (m) total += Number(m[1]);
  }
  return total;
}

/**
 * Builds a search the trade site accepts without login: a "count" group with the stats that matter (each with
 * a minimum roll), required stats in an "and" group, the base's defences, the budget as Exalted-equivalent
 * price limit (no currency option – otherwise only listings priced in that very currency would match),
 * cheapest first.
 */
export function anonymousUpgradeQuery(pob: TradeQuery, stats: SearchStat[], opts: AnonymousQueryOptions): TradeQuery {
  const share = opts.rollShare ?? DEFAULT_ROLL_SHARE;
  if (stats.length === 0) throw new Error('Path of Building found no mods that improve this slot');

  const countFilters: TradeStatFilter[] = stats.map((m) => {
    const min = m.value !== null ? Math.floor(m.value * share) : 0;
    return min >= 1 ? { id: m.id, value: { min } } : { id: m.id };
  });

  const filters: NonNullable<TradeQuery['query']['filters']> = {};
  const type = pob.query.filters?.type_filters;
  if (type) filters.type_filters = { filters: { ...type.filters } };
  if (opts.equipment) filters.equipment_filters = { filters: { ...opts.equipment } };
  filters.trade_filters = { filters: { price: { max: Math.max(1, Math.floor(opts.maxExalted)) } } };

  const stats_: TradeStatGroup[] = [{ type: 'count', value: { min: Math.min(opts.minCount ?? DEFAULT_MIN_COUNT, stats.length) }, filters: countFilters }];
  if (opts.required?.length) stats_.push({ type: 'and', filters: opts.required });

  return {
    query: { status: pob.query.status ?? { option: 'securable' }, filters, stats: stats_ },
    sort: { price: 'asc' },
  };
}

export interface Weights {
  /** Weight of the main skill's DPS change (0…1). */
  dps: number;
  /** Weight of the effective health pool change (0…1). */
  ehp: number;
}

export interface ScoredCandidate {
  key: string;
  verdict: SlotVerdict;
  /** Problems this item would newly cause (resistance below cap, attributes, spirit, movement speed). */
  blocking: string[];
  /** Price in Divine, if the currency could be converted. */
  priceDivine: number | null;
  /** Weighted gain in % (DPS and EHP by the chosen weights). */
  gain: number;
  /** Weighted gain per Divine spent (null without a known price). */
  gainPerDivine: number | null;
  upgrade: boolean;
}

/** Gains below this (in %) count as "about the same". */
export const MIN_GAIN_PCT = 1;

export function scoreCandidate(key: string, verdict: SlotVerdict, blocking: string[], priceDivine: number | null, w: Weights): ScoredCandidate {
  const gain = w.dps * verdict.dpsPct + w.ehp * verdict.ehpPct;
  const upgrade = blocking.length === 0 && gain >= MIN_GAIN_PCT;
  const gainPerDivine = priceDivine && priceDivine > 0 ? gain / priceDivine : null;
  return { key, verdict, blocking, priceDivine, gain, gainPerDivine, upgrade };
}

/** Real upgrades first (best weighted gain first, cheaper on ties), then the rest; blocked items last. */
export function rankCandidates(list: ScoredCandidate[]): ScoredCandidate[] {
  const bucket = (c: ScoredCandidate) => (c.upgrade ? 0 : c.blocking.length ? 2 : 1);
  return [...list].sort((a, b) => bucket(a) - bucket(b) || b.gain - a.gain || (a.priceDivine ?? Infinity) - (b.priceDivine ?? Infinity));
}
