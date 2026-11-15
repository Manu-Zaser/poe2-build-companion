import { describe, expect, it } from 'vitest';
import { hardWarnings, judgeItem, judgeSlot } from '../src/shared/verdict';
import type { Stats } from '../src/shared/types';

const before: Stats = {
  CombinedDPS: 100_000,
  TotalEHP: 10_000,
  Life: 1500,
  FireResist: 75,
  MissingFireResist: 0,
  ColdResist: 70,
  MissingColdResist: 5,
  LightningResist: 75,
  MissingLightningResist: 0,
  ChaosResist: 0,
  MissingChaosResist: 75,
  Str: 100,
  ReqStr: 90,
  Dex: 200,
  ReqDex: 150,
  Int: 50,
  ReqInt: 0,
  SpiritUnreserved: 20,
};
const slot = (after: Stats) => ({ slot: 'Gloves', replaces: 'Old Gloves', after: { ...before, ...after }, delta: {} });

describe('judgeSlot', () => {
  it('calls more DPS and EHP better', () => {
    const v = judgeSlot(before, slot({ CombinedDPS: 108_000, TotalEHP: 10_210, Life: 1560 }));
    expect(v.kind).toBe('better');
    expect(v.dpsPct).toBeCloseTo(8);
    expect(v.ehpPct).toBeCloseTo(2.1);
    expect(v.changes).toEqual([{ key: 'Life', label: 'Life', delta: 60, unit: '', good: true }]);
  });

  it('calls less of both worse, one up one down a trade-off, tiny changes the same', () => {
    expect(judgeSlot(before, slot({ CombinedDPS: 90_000, TotalEHP: 9_900 })).kind).toBe('worse');
    expect(judgeSlot(before, slot({ CombinedDPS: 120_000, TotalEHP: 9_000 })).kind).toBe('mixed');
    expect(judgeSlot(before, slot({ CombinedDPS: 100_200 })).kind).toBe('same');
  });

  it('puts hard warnings above better numbers', () => {
    const v = judgeSlot(before, slot({ CombinedDPS: 110_000, FireResist: 60, MissingFireResist: 15 }));
    expect(v.kind).toBe('warning');
    expect(v.warnings).toEqual(['Fire resistance falls below the cap (60% of 75%)']);
  });
});

describe('hardWarnings', () => {
  it('only warns about what gets worse', () => {
    // Cold already 5 below cap: only warn if it gets further below; chaos unchanged.
    expect(hardWarnings(before, { ...before, ColdResist: 70 })).toEqual([]);
    expect(hardWarnings(before, { ...before, ColdResist: 60, MissingColdResist: 15 })).toEqual(['Cold resistance drops further below the cap (60% of 75%)']);
  });

  it('warns about attribute requirements and spirit', () => {
    expect(hardWarnings(before, { ...before, Str: 80 })).toEqual(['Not enough Strength: 80 of 90 needed']);
    expect(hardWarnings(before, { ...before, SpiritUnreserved: -10 })).toEqual(['Spirit no longer covers your reservations (-10 free)']);
  });
});

describe('judgeItem', () => {
  it('orders ring slots best first and slots with warnings last', () => {
    const res = judgeItem(before, [
      { slot: 'Ring 1', replaces: 'A', after: { ...before, CombinedDPS: 130_000, FireResist: 50, MissingFireResist: 25 }, delta: {} },
      { slot: 'Ring 2', replaces: 'B', after: { ...before, CombinedDPS: 104_000 }, delta: {} },
    ]);
    expect(res.map((r) => r.slot)).toEqual(['Ring 2', 'Ring 1']);
  });
});
