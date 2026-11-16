import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeBuildCode } from '../src/shared/buildcode';
import { fitCount, fitForSlot, parsePobItem, parseTargetBuild, statsOfLine } from '../src/shared/targets';
import type { ItemInfo } from '../src/shared/types';

const target = parseTargetBuild(decodeBuildCode(readFileSync(join(__dirname, 'fixtures/deadeye.code'), 'utf8')));

const item = (mods: string[], extra: Partial<ItemInfo> = {}): ItemInfo => ({
  name: 'Test, Base',
  title: 'Test',
  base: 'Base',
  rarity: 'RARE',
  corrupted: false,
  raw: '',
  mods: mods.map((text) => ({ text, kind: 'explicit' as const })),
  ...extra,
});

describe('statsOfLine', () => {
  it('turns numbers into # and ignores PoB markers and roll ranges', () => {
    expect(statsOfLine('{crafted}+112(100-119) to maximum Life')).toEqual([{ key: '+# to maximum life', label: '+# to maximum Life', value: 112 }]);
    expect(statsOfLine('Adds 15 to 22 Fire damage to Attacks')[0].label).toBe('Adds # to # Fire damage to Attacks');
  });

  it('understands resistances, including hybrid and all elemental', () => {
    expect(statsOfLine('+28% to Fire Resistance').map((s) => s.key)).toEqual(['res:fire']);
    expect(statsOfLine('+15% to Fire and Cold Resistances').map((s) => s.key)).toEqual(['res:fire', 'res:cold']);
    expect(statsOfLine('+16% to all Elemental Resistances').map((s) => s.key)).toEqual(['res:all']);
    expect(statsOfLine('+1% to Maximum Cold Resistance')[0].key).toBe('max-res:maximum cold');
  });

  it('marks filler stats as minor', () => {
    expect(statsOfLine('14% increased Rarity of Items found')[0].minor).toBe(true);
    expect(statsOfLine('30% increased Movement Speed')[0].minor).toBeUndefined();
  });
});

describe('parsePobItem', () => {
  it('skips meta lines, implicits, runes and enchants', () => {
    const it = parsePobItem(`
      Rarity: RARE
      Doom Shell
      Wayfarer Jacket
      Unique ID: abc
      Item Level: 81
      Quality: 20
      Implicits: 1
      +10% to Cold Resistance
      {rune}+18% to Fire Resistance
      +112 to maximum Life
      <ModRange id="1" range="0.5"/>
      Corrupted`);
    expect(it).toEqual({ name: 'Doom Shell', base: 'Wayfarer Jacket', rarity: 'RARE', explicits: ['+112 to maximum Life'] });
  });
});

describe('parseTargetBuild', () => {
  it('reads the slots of the active item set and the weapon set the build uses', () => {
    expect(target.ascendancy).toBe('Deadeye');
    expect(target.slots.map((s) => s.slot)).toEqual(['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt']);
    // This build fights with weapon set II.
    expect(target.slots[0].name).toBe('Tangletongue');
    const boots = target.slots.find((s) => s.slot === 'Boots')!;
    expect(boots.unique).toBe(false);
    expect(boots.wanted.map((w) => w.label)).toContain('#% increased Movement Speed');
    expect(target.slots.find((s) => s.slot === 'Belt')).toMatchObject({ unique: true, wanted: [{ label: 'Headhunter' }] });
  });
});

describe('fitForSlot', () => {
  it('lists which target stats an item has and which are missing', () => {
    const boots = item(['35% increased Movement Speed', '+26% to Chaos Resistance', '+40 to Intelligence', '15% increased Rarity of Items found']);
    const fit = fitForSlot(target, 'Boots', boots)!;
    expect(fit.have.map((w) => w.label)).toEqual(['Chaos Resistance', '+# to Intelligence', '#% increased Movement Speed']);
    expect(fit.have.find((w) => w.label === '#% increased Movement Speed')).toMatchObject({ value: 30, itemValue: 35 });
    expect(fit.missing.map((w) => w.label)).toEqual(['+# to maximum Energy Shield', '#% increased Energy Shield', '#% increased effect of Socketed Augment Items']);
    expect(fitCount(fit)).toEqual({ have: 3, total: 6 });
  });

  it('lets all elemental resistances cover a single one', () => {
    const helmet = item(['+10% to all Elemental Resistances']);
    const t = parseTargetBuild(`<PathOfBuilding2><Build level="1"/><Items activeItemSet="1"><Item id="1">Rarity: RARE
X
Cap
Implicits: 0
+30% to Fire Resistance</Item><ItemSet id="1"><Slot name="Helmet" itemId="1"/></ItemSet></Items></PathOfBuilding2>`);
    expect(fitCount(fitForSlot(t, 'Helmet', helmet)!)).toEqual({ have: 1, total: 1 });
  });

  it('checks a unique target by name and compares rings with both target rings', () => {
    expect(fitCount(fitForSlot(target, 'Belt', item([], { name: 'Headhunter, Heavy Belt', title: 'Headhunter', rarity: 'UNIQUE' }))!)).toEqual({ have: 1, total: 1 });
    expect(fitCount(fitForSlot(target, 'Belt', item(['+80 to maximum Life']))!)).toEqual({ have: 0, total: 1 });
    // Ring 1 of the guide is The Taming (unique), Ring 2 a rare: a rare ring is compared with Ring 2.
    const ring = item(['Adds 10 to 20 Fire damage to Attacks', '+12% to all Elemental Resistances']);
    expect(fitForSlot(target, 'Ring 1', ring)!.targetSlot).toBe('Ring 2');
  });

  it('returns nothing for slots the guide leaves empty', () => {
    expect(fitForSlot({ slots: [] }, 'Boots', item(['+1 to Strength']))).toBeNull();
  });
});
