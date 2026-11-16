/**
 * Runs the upgrade search slot by slot (see shared/upgrades.ts for the idea):
 * PoB weighs the mods → anonymous count search on the trade site → fetch the cheapest listings →
 * PoB calculates each one in the build → ranking. Buying stays with the user (trade site link).
 *
 * No Electron imports here, so the whole flow can be tested with a fake engine and trade client.
 */
import { budgetInExalted, toDivine, type CurrencyRates } from '@poe2/core/ninja';
import { RateLimitError, type FetchedListing, type SearchResponse } from '@poe2/core/trade';
import { tradeItemToPob, type TradeItem } from '../shared/tradeitem';
import type { ItemInfo, Stats, UpgradeCandidate, UpgradeProgress, UpgradeRequest, UpgradeSlotResult } from '../shared/types';
import {
  anonymousUpgradeQuery,
  ENOUGH_RESULTS,
  MOVEMENT_SPEED_STAT,
  movementSpeedOf,
  pickCandidates,
  QUERY_STEPS,
  rankCandidates,
  scoreCandidate,
  tradeSearchUrl,
  type PobModWeight,
  type TradeQuery,
} from '../shared/upgrades';
import { blockingWarnings, judgeSlot } from '../shared/verdict';

/** Candidates shown per slot. */
export const SHOWN_PER_SLOT = 6;
/** Longest wait for the trade site's rate limit before giving up (the limit then lasts minutes). */
export const MAX_RATE_WAIT_MS = 90_000;

export interface UpgradeDeps {
  /** A request to the PoB engine with the current build loaded; resolves with the result. */
  engine: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
  trade: { search(league: string, query: unknown): Promise<SearchResponse>; fetchListings(queryId: string, ids: string[]): Promise<FetchedListing[]> };
  rates: CurrencyRates;
  league: string;
  onProgress?: (p: UpgradeProgress) => void;
  onSlotDone?: (r: UpgradeSlotResult) => void;
  /** true once the user cancelled or the build changed. */
  cancelled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

interface EvaluateResult {
  slot: string;
  replaces: string | null;
  before: Stats;
  results: ({ key: string; item: ItemInfo; after: Stats } | { key: string; error: string })[];
}

export class SearchCancelled extends Error {
  constructor() {
    super('Search cancelled.');
  }
}

/** Waits out the trade site's rate limit (with progress) instead of failing; gives up on long blocks. */
async function rateLimited<T>(fn: () => Promise<T>, deps: UpgradeDeps, progress: UpgradeProgress): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RateLimitError) || err.waitMs > MAX_RATE_WAIT_MS || attempt >= 3) throw err;
      // In Sekundenschritten warten, damit der Fortschritt mitzählt und Abbrechen sofort greift.
      for (let left = err.waitMs + 250; left > 0; left -= 1000) {
        if (deps.cancelled?.()) throw new SearchCancelled();
        deps.onProgress?.({ ...progress, step: 'wait', waitS: Math.ceil(left / 1000) });
        await sleep(Math.min(1000, left));
      }
      deps.onProgress?.(progress);
    }
  }
}

export async function searchSlot(
  slot: string,
  current: ItemInfo | null,
  req: UpgradeRequest,
  deps: UpgradeDeps,
  at: { index: number; count: number },
): Promise<UpgradeSlotResult> {
  const step = (s: UpgradeProgress['step']): UpgradeProgress => ({ slot, index: at.index, count: at.count, step: s });
  const check = () => {
    if (deps.cancelled?.()) throw new SearchCancelled();
  };
  const result: UpgradeSlotResult = { slot, current: current ? (current.title ?? current.name) : null, total: 0, evaluated: 0, candidates: [] };
  const dps = Math.min(1, Math.max(0, req.dpsWeight));

  deps.onProgress?.(step('weights'));
  const pob = await deps.engine<{ query: TradeQuery; mods: PobModWeight[] }>('upgradeQuery', {
    slot,
    dpsWeight: dps,
    ehpWeight: 1 - dps,
    instantOnly: req.instantOnly,
  });
  check();

  // Stiefel ohne Bewegungstempo sind fast nie ein Upgrade – mindestens so viel wie jetzt verlangen.
  const ms = slot === 'Boots' ? movementSpeedOf((current?.mods ?? []).map((m) => m.text)) : 0;
  const required = ms > 0 ? [{ id: MOVEMENT_SPEED_STAT, value: { min: ms } }] : [];
  const maxExalted = budgetInExalted(deps.rates, req.budget, req.currency);

  let found: SearchResponse | null = null;
  for (const s of QUERY_STEPS) {
    const query = anonymousUpgradeQuery(pob.query, pob.mods, { maxExalted, minCount: s.minCount, rollShare: s.rollShare, required });
    deps.onProgress?.(step('search'));
    found = await rateLimited(() => deps.trade.search(deps.league, query), deps, step('search'));
    check();
    if (found.total >= ENOUGH_RESULTS) break;
  }
  if (!found) return result;
  result.total = found.total;
  result.tradeUrl = tradeSearchUrl(deps.league, found.id);
  if (found.result.length === 0) return result;

  const ids = pickCandidates(found.result);
  const listings: FetchedListing[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    deps.onProgress?.(step('fetch'));
    listings.push(...(await rateLimited(() => deps.trade.fetchListings(found.id, ids.slice(i, i + 10)), deps, step('fetch'))));
    check();
  }

  const items: { key: string; itemText: string }[] = [];
  for (const l of listings) {
    try {
      items.push({ key: l.id, itemText: tradeItemToPob(l.item as unknown as TradeItem) });
    } catch {
      // Angebot ohne lesbares Item – überspringen.
    }
  }
  deps.onProgress?.(step('evaluate'));
  const ev = await deps.engine<EvaluateResult>('evaluate', { slot, items });
  check();

  const scored: { s: ReturnType<typeof scoreCandidate>; c: UpgradeCandidate }[] = [];
  for (const r of ev.results) {
    if ('error' in r) continue;
    const l = listings.find((x) => x.id === r.key);
    if (!l) continue;
    const price = l.listing.price ? { amount: l.listing.price.amount, currency: l.listing.price.currency } : null;
    const priceDivine = price ? toDivine(deps.rates, price.amount, price.currency) : null;
    const verdict = judgeSlot(ev.before, { slot, replaces: ev.replaces, after: r.after, delta: {} });
    const s = scoreCandidate(r.key, verdict, blockingWarnings(ev.before, r.after), priceDivine, { dps, ehp: 1 - dps });
    scored.push({
      s,
      c: {
        item: r.item,
        price,
        priceDivine,
        dpsPct: verdict.dpsPct,
        ehpPct: verdict.ehpPct,
        gain: s.gain,
        upgrade: s.upgrade,
        blocking: s.blocking,
        warnings: verdict.warnings.filter((w) => !s.blocking.includes(w)),
        changes: verdict.changes,
        ...(l.listing.indexed ? { listedAt: l.listing.indexed } : {}),
      },
    });
  }
  result.evaluated = scored.length;
  result.candidates = rankCandidates(scored.map((x) => x.s))
    .slice(0, SHOWN_PER_SLOT)
    .map((s) => scored.find((x) => x.s === s)!.c);
  return result;
}

/**
 * Searches all requested slots one after another. A slot that fails is reported and the search goes on;
 * a long rate-limit block or cancelling stops everything (no further requests).
 */
export async function runUpgradeSearch(req: UpgradeRequest, gear: { slot: string; item: ItemInfo | null }[], deps: UpgradeDeps): Promise<UpgradeSlotResult[]> {
  const results: UpgradeSlotResult[] = [];
  for (const [index, slot] of req.slots.entries()) {
    const current = gear.find((g) => g.slot === slot)?.item ?? null;
    let r: UpgradeSlotResult;
    try {
      r = await searchSlot(slot, current, req, deps, { index, count: req.slots.length });
    } catch (err) {
      if (err instanceof SearchCancelled || err instanceof RateLimitError) throw err;
      r = { slot, current: current ? (current.title ?? current.name) : null, total: 0, evaluated: 0, candidates: [], error: err instanceof Error ? err.message : String(err) };
    }
    results.push(r);
    deps.onSlotDone?.(r);
  }
  return results;
}
