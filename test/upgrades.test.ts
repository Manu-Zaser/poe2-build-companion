import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RateLimitError, type FetchedListing } from '@poe2/core/trade';
import type { CurrencyRates } from '@poe2/core/ninja';
import { escapeGGG, tradeItemToPob, type TradeItem } from '../src/shared/tradeitem';
import {
  anonymousUpgradeQuery,
  ENOUGH_RESULTS,
  MOVEMENT_SPEED_STAT,
  listingUrl,
  movementSpeedOf,
  pickCandidates,
  rankCandidates,
  scoreCandidate,
  tradeSearchUrl,
  type PobModWeight,
  type TradeQuery,
} from '../src/shared/upgrades';
import { blockingWarnings, judgeSlot } from '../src/shared/verdict';
import { runUpgradeSearch, searchSlot, SearchCancelled, type UpgradeDeps } from '../src/main/upgradesearch';
import type { ItemInfo, Stats, UpgradeRequest } from '../src/shared/types';

// Three real boots listings from the trade site (account data removed).
const listings = JSON.parse(readFileSync(join(__dirname, 'fixtures/trade-boots.json'), 'utf8')) as FetchedListing[];

describe('trade item → Path of Building text', () => {
  it('writes rarity, name, base, properties and mods', () => {
    const text = tradeItemToPob(listings[0].item as unknown as TradeItem);
    expect(text.split('\n').slice(0, 3)).toEqual(['Rarity: Rare', 'Beast Span', 'Wanderer Shoes']);
    expect(text).toContain('Evasion: 122');
    expect(text).toContain('Energy Shield: 37');
    expect(text).toContain('Item Level: 79');
    expect(text).toContain('Implicits: 0');
    expect(text).toContain('30% increased Movement Speed');
    expect(text).toContain('+84 to maximum Life');
  });

  it('marks socketed runes as enchant/rune lines and keeps the corruption', () => {
    const runes = tradeItemToPob(listings[1].item as unknown as TradeItem);
    expect(runes).toContain('Sockets: S');
    expect(runes).toContain('Implicits: 2');
    expect(runes).toContain('{enchant}{rune}5% increased Movement Speed');
    const corrupted = tradeItemToPob(listings[2].item as unknown as TradeItem);
    expect(corrupted).toContain('Quality: 20');
    expect(corrupted.trim().endsWith('Corrupted')).toBe(true);
  });

  it('removes the trade site markup from mod texts', () => {
    expect(escapeGGG('[Evasion|Evasion Rating]')).toBe('Evasion Rating');
    expect(escapeGGG('+10 to [Strength]')).toBe('+10 to Strength');
  });
});

const pobQuery: TradeQuery = {
  query: {
    status: { option: 'securable' },
    filters: { type_filters: { filters: { category: { option: 'armour.boots' } } } },
    stats: [{ type: 'weight', filters: [] }],
  },
  sort: { 'statgroup.0': 'desc' },
};
const mods: PobModWeight[] = [
  { id: 'explicit.stat_life', weight: 2, effect: 160, testedValue: 80 },
  { id: 'explicit.stat_cold', weight: 1, effect: 30, testedValue: 30 },
  { id: 'explicit.stat_small', weight: 0.5, effect: 0.3, testedValue: 0.6 },
  { id: 'explicit.stat_useless', weight: 0, effect: 0, testedValue: 10 },
];

describe('anonymous upgrade search', () => {
  it('builds a count search with minimum rolls, the price limit in Exalted and cheapest first', () => {
    const q = anonymousUpgradeQuery(pobQuery, mods, { maxExalted: 1098.4, minCount: 3, rollShare: 0.7, required: [{ id: MOVEMENT_SPEED_STAT, value: { min: 30 } }] });
    expect(q.sort).toEqual({ price: 'asc' });
    expect(q.query.status).toEqual({ option: 'securable' });
    expect(q.query.filters?.type_filters).toEqual({ filters: { category: { option: 'armour.boots' } } });
    // No currency option – otherwise only listings priced in that currency would match.
    expect(q.query.filters?.trade_filters).toEqual({ filters: { price: { max: 1098 } } });
    const [count, and] = q.query.stats;
    expect(count.type).toBe('count');
    expect(count.value).toEqual({ min: 3 });
    // Mods without value for the build are left out; tiny rolls have no minimum.
    expect(count.filters).toEqual([{ id: 'explicit.stat_life', value: { min: 56 } }, { id: 'explicit.stat_cold', value: { min: 21 } }, { id: 'explicit.stat_small' }]);
    expect(and).toEqual({ type: 'and', filters: [{ id: MOVEMENT_SPEED_STAT, value: { min: 30 } }] });
  });

  it('never asks for more mods than it searches for', () => {
    const q = anonymousUpgradeQuery(pobQuery, mods, { maxExalted: 100, minCount: 4 });
    expect(q.query.stats[0].value).toEqual({ min: 3 });
  });

  it('fails clearly when PoB finds nothing worth searching', () => {
    expect(() => anonymousUpgradeQuery(pobQuery, [mods[3]], { maxExalted: 100 })).toThrow(/no mods/);
  });

  it('reads movement speed from mod lines', () => {
    expect(movementSpeedOf(['30% increased Movement Speed', '+84 to maximum Life', '5% increased Movement Speed'])).toBe(35);
    expect(movementSpeedOf(['+84 to maximum Life'])).toBe(0);
  });

  it('calculates the cheapest listings plus a spread up to the budget', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id${i}`);
    const picked = pickCandidates(ids, 30, 10);
    expect(picked).toHaveLength(30);
    expect(new Set(picked).size).toBe(30);
    expect(picked.slice(0, 10)).toEqual(ids.slice(0, 10));
    expect(picked.at(-1)).toBe('id99');
    expect(pickCandidates(ids.slice(0, 7))).toEqual(ids.slice(0, 7));
  });

  it('links one listing: same search, limited to the seller and base type', () => {
    const q = anonymousUpgradeQuery(pobQuery, mods, { maxExalted: 500 });
    const url = listingUrl('Forbidden Rites', q, 'Seller#1234', 'Wanderer Shoes');
    expect(url.startsWith('https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites?q=')).toBe(true);
    const back = JSON.parse(decodeURIComponent(url.split('?q=')[1])) as TradeQuery;
    expect(back.query.type).toBe('Wanderer Shoes');
    expect(back.query.filters?.trade_filters).toEqual({ filters: { price: { max: 500 } , account: { input: 'Seller#1234' } } });
    expect(back.query.stats).toEqual(q.query.stats);
    // The original query stays untouched.
    expect(q.query.type).toBeUndefined();
  });

  it('links the search on the trade site', () => {
    expect(tradeSearchUrl('Forbidden Rites', 'Ab12Cd')).toBe('https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/Ab12Cd');
  });
});

const before: Stats = { CombinedDPS: 1000, TotalEHP: 10000, FireResist: 75, MissingFireResist: 0, ColdResist: 70, MissingColdResist: 5, Str: 100, ReqStr: 90, EffectiveMovementSpeedMod: 1.3 };

describe('blocking warnings', () => {
  it('rules out items that newly drop a resistance below the cap or miss attributes', () => {
    const w = blockingWarnings(before, { ...before, FireResist: 60, MissingFireResist: 15, Str: 80 });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/Fire resistance falls below the cap/);
    expect(w[1]).toMatch(/Not enough Strength/);
  });

  it('does not rule out a resistance that was already below the cap', () => {
    expect(blockingWarnings(before, { ...before, ColdResist: 60, MissingColdResist: 15 })).toEqual([]);
  });

  it('rules out losing movement speed', () => {
    expect(blockingWarnings(before, { ...before, EffectiveMovementSpeedMod: 1.25 })[0]).toMatch(/Movement speed drops \(30% → 25%\)/);
  });
});

describe('scoring and ranking', () => {
  const verdict = (dps: number, ehp: number) =>
    judgeSlot(before, { slot: 'Boots', replaces: null, after: { ...before, CombinedDPS: 1000 * (1 + dps / 100), TotalEHP: 10000 * (1 + ehp / 100) }, delta: {} });

  it('weights DPS and EHP and needs at least 1 % gain', () => {
    const a = scoreCandidate('a', verdict(4, -2), [], 1, { dps: 0.5, ehp: 0.5 });
    expect(a.gain).toBeCloseTo(1);
    expect(a.upgrade).toBe(true);
    expect(scoreCandidate('b', verdict(4, -2), [], 1, { dps: 0, ehp: 1 }).upgrade).toBe(false);
    expect(scoreCandidate('c', verdict(10, 10), ['Fire resistance falls below the cap'], 1, { dps: 0.5, ehp: 0.5 }).upgrade).toBe(false);
  });

  it('lists upgrades first, blocked items last, cheaper first on ties', () => {
    const w = { dps: 0.5, ehp: 0.5 };
    const list = [
      scoreCandidate('blocked', verdict(20, 20), ['x'], 1, w),
      scoreCandidate('worse', verdict(-1, 0), [], 1, w),
      scoreCandidate('good-expensive', verdict(4, 4), [], 2, w),
      scoreCandidate('good-cheap', verdict(4, 4), [], 0.5, w),
      scoreCandidate('best', verdict(10, 0), [], 3, w),
    ];
    expect(rankCandidates(list).map((c) => c.key)).toEqual(['best', 'good-cheap', 'good-expensive', 'worse', 'blocked']);
  });
});

// ---------- whole flow with a fake engine and trade site ----------

const rates: CurrencyRates = { league: 'Forbidden Rites', exaltedPerDivine: 500, divineValue: { divine: 1, exalted: 1 / 500, chaos: 0.02 }, fetchedAt: 0 };
const boots: ItemInfo = { name: 'Old Boots', base: 'Wanderer Shoes', rarity: 'RARE', corrupted: false, mods: [{ text: '25% increased Movement Speed', kind: 'explicit' }], raw: '' };
const req: UpgradeRequest = { budget: 2, currency: 'divine', slots: ['Boots'], dpsWeight: 0.5, instantOnly: true };

function fakes(total: number[]) {
  const calls: string[] = [];
  const searches: unknown[] = [];
  let n = 0;
  const deps: UpgradeDeps = {
    league: 'Forbidden Rites',
    rates,
    engine: async <T,>(cmd: string, args: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === 'upgradeQuery') return { query: pobQuery, mods } as T;
      const items = args.items as { key: string; itemText: string }[];
      return {
        slot: 'Boots',
        replaces: 'Old Boots',
        before,
        // The second listing is the real upgrade (+6 % EHP); the first loses DPS.
        results: items.map((it, i) => ({
          key: it.key,
          item: { ...boots, name: `Candidate ${i}`, mods: [] },
          after: { ...before, CombinedDPS: i === 0 ? 950 : 1000, TotalEHP: i === 1 ? 10600 : 10000 },
        })),
      } as T;
    },
    trade: {
      search: async (_league, query) => {
        searches.push(query);
        const t = total[n++] ?? 0;
        return { id: `q${n}`, total: t, result: listings.slice(0, Math.min(t, 3)).map((l) => l.id) };
      },
      fetchListings: async (_id, ids) =>
        listings.filter((l) => ids.includes(l.id)).map((l) => ({ ...l, listing: { ...l.listing, account: { name: 'Seller#1' } } })),
    },
  };
  return { deps, calls, searches };
}

describe('upgrade search flow', () => {
  it('finds the upgrade and links the search', async () => {
    const { deps, searches } = fakes([25]);
    const r = await searchSlot('Boots', boots, req, deps, { index: 0, count: 1 });
    expect(searches).toHaveLength(1);
    expect(r.total).toBe(25);
    expect(r.evaluated).toBe(3);
    expect(r.tradeUrl).toBe('https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/q1');
    expect(r.candidates[0].item.name).toBe('Candidate 1');
    expect(r.candidates[0].upgrade).toBe(true);
    expect(r.candidates[0].ehpPct).toBeCloseTo(6);
    expect(r.candidates[0].tradeUrl).toContain(encodeURIComponent('"account":{"input":"Seller#1"}'));
    expect(r.candidates[0].price).toEqual({ amount: listings[1].listing.price!.amount, currency: listings[1].listing.price!.currency });
    // Boots must keep the current movement speed; the budget is the Exalted equivalent.
    const q = searches[0] as TradeQuery;
    expect(q.query.stats[1]).toEqual({ type: 'and', filters: [{ id: MOVEMENT_SPEED_STAT, value: { min: 25 } }] });
    expect(q.query.filters?.trade_filters).toEqual({ filters: { price: { max: 1000 } } });
  });

  it('leaves out listings above the budget even if the trade site let them through', async () => {
    const { deps } = fakes([25]);
    const fetch = deps.trade.fetchListings;
    // Listing 0 costs 3 div – over the 2 div budget.
    deps.trade.fetchListings = async (id, ids) => (await fetch(id, ids)).map((l, i) => (i === 0 ? { ...l, listing: { ...l.listing, price: { type: '~b/o', amount: 3, currency: 'divine' } } } : l));
    const r = await searchSlot('Boots', boots, req, deps, { index: 0, count: 1 });
    expect(r.overBudget).toBe(1);
    expect(r.evaluated).toBe(2);
    expect(r.candidates.every((c) => (c.priceDivine ?? 0) <= 2)).toBe(true);
  });

  it('loosens the search when the strict one finds too little', async () => {
    const { deps, searches } = fakes([2, ENOUGH_RESULTS + 5]);
    const r = await searchSlot('Boots', boots, req, deps, { index: 0, count: 1 });
    expect(searches).toHaveLength(2);
    expect((searches[0] as TradeQuery).query.stats[0].value).toEqual({ min: 3 });
    expect(r.tradeUrl).toMatch(/\/q2$/);
  });

  it('waits out a short rate limit instead of failing', async () => {
    const { deps } = fakes([25]);
    let failed = false;
    const search = deps.trade.search;
    deps.trade.search = async (l, q) => {
      if (!failed) {
        failed = true;
        throw new RateLimitError(2000);
      }
      return search(l, q);
    };
    const waits: number[] = [];
    deps.sleep = async (ms) => void waits.push(ms);
    const r = await searchSlot('Boots', boots, req, deps, { index: 0, count: 1 });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2000);
  });

  it('stops on a long rate-limit block and on cancel; reports other errors per slot', async () => {
    const blocked = fakes([25]);
    blocked.deps.trade.search = async () => {
      throw new RateLimitError(600_000);
    };
    await expect(runUpgradeSearch(req, [{ slot: 'Boots', item: boots }], blocked.deps)).rejects.toBeInstanceOf(RateLimitError);

    const cancelled = fakes([25]);
    cancelled.deps.cancelled = () => true;
    await expect(runUpgradeSearch(req, [{ slot: 'Boots', item: boots }], cancelled.deps)).rejects.toBeInstanceOf(SearchCancelled);

    const broken = fakes([25, 25]);
    broken.deps.trade.search = async () => {
      throw new Error('Trade API: Query is too complex');
    };
    const res = await runUpgradeSearch({ ...req, slots: ['Boots', 'Helmet'] }, [{ slot: 'Boots', item: boots }], broken.deps);
    expect(res.map((r) => r.error)).toEqual(['Trade API: Query is too complex', 'Trade API: Query is too complex']);
    expect(res[1].current).toBeNull();
  });
});
