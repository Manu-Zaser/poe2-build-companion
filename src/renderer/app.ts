import type { Api } from '../main/preload';
import type { BuildView, GearSlot, ItemIcon, ItemInfo, Overview, PobFileEntry, SkillDps, Stats, UpgradeCandidate, UpgradeRun, UpgradeSlotResult } from '../shared/types';
import { UPGRADE_SLOTS } from '../shared/upgrades';
import { fitAgainst } from '../shared/targets';
import { acceleratorFromEvent, formatHotkey, validateHotkey } from '@poe2/core/hotkey';
import { ageText, compact, fmt, isStale, short } from './format';

declare global {
  interface Window { api: Api }
}
const api = window.api;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

let current: BuildView | null = null;
/** Weapon set shown in the equipment view (null = the build's active set). */
let shownSet: number | null = null;
/** Slots holding an item equipped here via the item check (not in the imported build). */
let localSlots = new Set<string>();

// ---------- Navigation ----------

function showPage(name: string) {
  for (const b of document.querySelectorAll<HTMLElement>('.nav-item')) b.classList.toggle('active', b.dataset.page === name);
  for (const p of document.querySelectorAll<HTMLElement>('.page')) {
    const active = p.dataset.page === name;
    p.classList.toggle('active', active);
    if (active) {
      $('page-title').textContent = p.dataset.title ?? '';
      $('page-sub').textContent = p.dataset.sub ?? '';
    }
  }
}
for (const b of document.querySelectorAll<HTMLElement>('[data-page].nav-item, [data-goto]')) {
  b.addEventListener('click', () => showPage(b.dataset.page ?? b.dataset.goto ?? 'character'));
}

// ---------- Messages ----------

let msgTimer: ReturnType<typeof setTimeout> | undefined;
function message(text: string, kind: 'ok' | 'error' | 'warn' = 'ok') {
  const box = $('msg');
  box.textContent = text;
  box.className = `banner${kind === 'ok' ? '' : ` ${kind}`}`;
  box.hidden = !text;
  clearTimeout(msgTimer);
  if (text && kind === 'ok') msgTimer = setTimeout(() => (box.hidden = true), 5000);
}

/** Runs an action with a busy button and shows its result. */
async function run(button: HTMLButtonElement, action: () => Promise<{ ok: boolean; error?: string; view: BuildView }>, success: string) {
  const buttons = document.querySelectorAll<HTMLButtonElement>('button');
  buttons.forEach((b) => (b.disabled = true));
  button.classList.add('busy');
  message('');
  try {
    const res = await action();
    render(res.view);
    if (res.ok) message(success);
    else message(res.error ?? 'Something went wrong.', 'error');
  } finally {
    button.classList.remove('busy');
    buttons.forEach((b) => (b.disabled = false));
  }
}

// ---------- Items: pictures and tooltip ----------

/** PoB slot → game inventory id (used when an item cannot be matched by name). */
const INVENTORY_IDS: Record<string, string> = {
  'Weapon 1': 'Weapon',
  'Weapon 2': 'Offhand',
  'Weapon 1 Swap': 'Weapon2',
  'Weapon 2 Swap': 'Offhand2',
  Helmet: 'Helm',
  'Body Armour': 'BodyArmour',
  Gloves: 'Gloves',
  Boots: 'Boots',
  Amulet: 'Amulet',
  'Ring 1': 'Ring',
  'Ring 2': 'Ring2',
  Belt: 'Belt',
};

/**
 * Picture for an item: the same item on the poe.ninja profile; otherwise, for rare and magic items, any
 * item of the same base (they look like their base in game); for builds from poe.ninja itself also the
 * item in the same slot. Uniques only ever get their own picture.
 */
function iconFor(item: ItemInfo, slot: string, icons: ItemIcon[]): string | undefined {
  const byName = icons.find((i) => i.name === item.name);
  if (byName) return byName.url;
  if (item.rarity !== 'UNIQUE' && item.rarity !== 'RELIC') {
    const byBase = icons.find((i) => i.base === item.base && !i.unique);
    if (byBase) return byBase.url;
  }
  // A locally equipped item never shows the replaced item's picture.
  if (current?.build?.source.kind !== 'ninja' || localSlots.has(slot)) return undefined;
  return icons.find((i) => i.inventoryId === INVENTORY_IDS[slot])?.url;
}

const rarityCls = (item: ItemInfo) => `rarity-${item.rarity.toLowerCase()}`;

function itemTooltip(item: ItemInfo): HTMLElement {
  const hasTitle = !!item.title && item.title !== item.base;
  const head = el('div', 'tip-head', el('div', `t1 ${rarityCls(item)}`, hasTitle ? item.title! : item.base), hasTitle && el('div', `t2 ${rarityCls(item)}`, item.base));
  const body = el('div', 'tip-body');
  const meta = [item.quality ? `Quality +${item.quality}%` : '', item.itemLevel ? `Item level ${item.itemLevel}` : ''].filter(Boolean).join(' · ');
  if (meta) body.append(el('div', 'meta', meta));
  let lastGroup = meta ? 'meta' : '';
  for (const m of item.mods) {
    const group = m.kind === 'explicit' || m.kind === 'unique' ? 'main' : m.kind;
    if (lastGroup && group !== lastGroup) body.append(el('div', 'sep'));
    lastGroup = group;
    body.append(el('div', `m ${m.kind}${m.inactive ? ' inactive' : ''}`, m.text));
  }
  if (item.corrupted) body.append(el('div', 'corrupted', 'Corrupted'));
  return el('div', '', head, body);
}

const tip = () => $('item-tip');
function attachTooltip(target: HTMLElement, item: ItemInfo) {
  target.addEventListener('mouseenter', () => {
    tip().replaceChildren(itemTooltip(item));
    tip().hidden = false;
    const r = target.getBoundingClientRect();
    const t = tip().getBoundingClientRect();
    // Right of the item if there is room, otherwise left; always inside the window.
    let x = r.right + 10;
    if (x + t.width > window.innerWidth - 8) x = Math.max(8, r.left - t.width - 10);
    const y = Math.min(Math.max(8, r.top), window.innerHeight - t.height - 8);
    tip().style.left = `${x}px`;
    tip().style.top = `${y}px`;
  });
  target.addEventListener('mouseleave', () => (tip().hidden = true));
}

function itemCell(item: ItemInfo | null, slot: string, icons: ItemIcon[], label: string): HTMLElement {
  if (!item) return el('div', 'cell', el('span', 'empty-label', label));
  const url = iconFor(item, slot, icons);
  const cell = el('div', `cell filled ${rarityCls(item)}`);
  const nameTile = () => el('span', `tile-name ${rarityCls(item)}`, item.title ?? item.base);
  if (url) {
    const img = el('img');
    img.src = url;
    img.alt = item.title ?? item.base;
    // Picture unavailable (offline, CDN change): show the name instead.
    img.addEventListener('error', () => img.replaceWith(nameTile()));
    cell.append(img);
  } else {
    cell.append(nameTile());
  }
  if (item.corrupted) cell.append(el('i', 'corrupt'));
  if (localSlots.has(slot)) {
    const dot = el('i', 'local');
    dot.title = 'Equipped here via the item check';
    cell.append(dot);
  }
  attachTooltip(cell, item);
  return cell;
}

// ---------- Equipment ----------

/** Slot (without " Swap"), grid area, label for empty slots. */
const DOLL: [string, string, string][] = [
  ['Weapon 1', 'w1', 'Main hand'],
  ['Weapon 2', 'w2', 'Off hand'],
  ['Helmet', 'he', 'Helmet'],
  ['Body Armour', 'bo', 'Body'],
  ['Amulet', 'am', 'Amulet'],
  ['Ring 1', 'r1', 'Ring'],
  ['Ring 2', 'r2', 'Ring'],
  ['Gloves', 'gl', 'Gloves'],
  ['Boots', 'ft', 'Boots'],
  ['Belt', 'be', 'Belt'],
];

function renderEquipment(ov: Overview, icons: ItemIcon[]) {
  const set = shownSet ?? ov.weaponSet;
  const bySlot = new Map<string, GearSlot>(ov.gear.map((g) => [g.slot, g]));
  $('doll').replaceChildren(
    ...DOLL.map(([slot, area, label]) => {
      const name = slot.startsWith('Weapon') && set === 2 ? `${slot} Swap` : slot;
      const cell = itemCell(bySlot.get(name)?.item ?? null, name, icons, label);
      cell.style.gridArea = area;
      return cell;
    }),
  );

  for (const b of document.querySelectorAll<HTMLButtonElement>('#set-toggle button')) {
    const n = Number(b.dataset.set);
    b.classList.toggle('active', n === set);
    b.replaceChildren(n === 1 ? 'I' : 'II', n === ov.weaponSet ? el('span', 'dot') : '');
    b.title = n === ov.weaponSet ? `Weapon set ${n} – used by the build` : `Weapon set ${n}`;
  }

  const flasks = ov.gear.filter((g) => g.item && g.slot.startsWith('Flask'));
  const charms = ov.gear.filter((g) => g.item && g.slot.startsWith('Charm'));
  const belt: HTMLElement[] = flasks.map((g) => {
    const c = itemCell(g.item, g.slot, icons, '');
    c.classList.add('tall');
    return c;
  });
  if (flasks.length && charms.length) belt.push(el('span', 'gap'));
  belt.push(...charms.map((g) => itemCell(g.item, g.slot, icons, '')));
  $('belt-items').replaceChildren(...belt);

  $('jewels-wrap').hidden = ov.jewels.length === 0;
  $('jewels').replaceChildren(
    ...ov.jewels.map((j) => {
      const text = el('div', 'jewel-text', el('b', rarityCls(j.item), j.item.title ?? j.item.base), j.item.title && el('span', '', j.item.base));
      // Without a picture the name alone is clearer than a tiny name tile.
      const pic = iconFor(j.item, j.slot, icons) ? itemCell(j.item, j.slot, icons, '') : null;
      const row = el('div', 'jewel', pic, text);
      attachTooltip(row, j.item);
      return row;
    }),
  );
}

// ---------- Skills & passives ----------

function renderGemGroups(ov: Overview) {
  const groups = ov.gemGroups.filter((g) => g.gems.some((x) => !x.support));
  $('skills-note').textContent = `${groups.filter((g) => g.enabled).length} active groups`;
  if (groups.length === 0) {
    $('gem-groups').replaceChildren(el('p', 'empty-note', 'No skills in this build.'));
    return;
  }
  $('gem-groups').replaceChildren(
    ...groups.map((g) => {
      const actives = g.gems.filter((x) => !x.support);
      const supports = g.gems.filter((x) => x.support);
      const box = el('div', `gem-group${g.main ? ' main' : ''}${g.enabled ? '' : ' off'}`);
      actives.forEach((a, i) => {
        const lv = [a.level !== undefined ? String(a.level) : '', a.quality ? `${a.quality}%` : ''].filter(Boolean).join(' / ');
        box.append(el('div', 'gem-active', el('span', '', a.name), lv && el('span', 'lv', lv)));
        if (i === 0) {
          const tags = [g.main && 'Main skill', g.fromItem && 'from item', !g.enabled && 'disabled', g.label].filter(Boolean).join(' · ');
          if (tags) box.append(el('div', 'tag-line', tags));
        }
      });
      if (supports.length) box.append(el('ul', 'supports', ...supports.map((s) => el('li', s.enabled ? '' : 'off', s.name))));
      return box;
    }),
  );
}

function renderPassives(ov: Overview) {
  const p = ov.passives;
  $('passive-note').textContent = `${p.points} passives${p.weaponSetPoints ? ` (incl. ${p.weaponSetPoints} weapon set)` : ''} · ${p.ascendancyPoints} ascendancy`;
  if (p.nodes.length === 0) {
    $('nodes').replaceChildren(el('p', 'empty-note', 'No ascendancy or keystones allocated.'));
    return;
  }
  $('nodes').replaceChildren(
    ...p.nodes.map((nd) => el('div', `node ${nd.kind}`, el('b', '', nd.name), el('small', '', nd.kind === 'ascendancy' ? 'Ascendancy' : 'Keystone'), ...nd.lines.map((l) => el('p', '', l)))),
  );
}

// ---------- Stats column ----------

const n = (s: Stats, k: string) => s[k] ?? 0;
type Row = [string, Node | string, string?] | HTMLElement;

function rows(id: string, list: Row[]) {
  $(id).replaceChildren(...list.flatMap((r) => (r instanceof HTMLElement ? [r] : [el('dt', '', r[0]), el('dd', r[2] ?? '', r[1])])));
}

/** "a / b / c" with each part coloured. */
function parts(values: [string, string][]): HTMLElement {
  const span = el('span');
  values.forEach(([text, cls], i) => {
    if (i) span.append(el('span', 'sl', '/'));
    span.append(el('span', cls, text));
  });
  return span;
}

const ELEMENTS = [
  ['Fire', 'c-fire'],
  ['Cold', 'c-cold'],
  ['Lightning', 'c-lightning'],
  ['Chaos', 'c-chaos'],
] as const;
const ATTRS = [
  ['Str', 'c-str'],
  ['Dex', 'c-dex'],
  ['Int', 'c-int'],
] as const;

function renderStats(ov: Overview) {
  const s = ov.stats;
  const unmet = ATTRS.filter(([k]) => n(s, `Req${k}`) > n(s, k));
  const charRows: Row[] = [
    ['Attributes', parts(ATTRS.map(([k, cls]) => [fmt(n(s, k)), cls]))],
    // PoB gives both as multipliers: 1.45 = 145 % movement speed, 2.15 = 115 % increased rarity.
    ['Movement speed', `${fmt(Math.round(n(s, 'EffectiveMovementSpeedMod') * 100))}%`],
    ['Item rarity', `${fmt(Math.round((n(s, 'EffectiveLootRarityMod') - 1) * 100))}%`],
    ['Charges', parts([[fmt(n(s, 'EnduranceChargesMax')), 'c-life'], [fmt(n(s, 'FrenzyChargesMax')), 'c-dex'], [fmt(n(s, 'PowerChargesMax')), 'c-int']])],
  ];
  if (unmet.length) charRows.push(el('div', 'cap-warn', `Requirement not met: ${unmet.map(([k]) => `${k} ${fmt(n(s, k))} of ${fmt(n(s, `Req${k}`))}`).join(', ')}`));
  rows('st-character', charRows);

  // Resistances: wavy red underline when below the cap, details in the tooltip and the warning below.
  const res = el('span');
  const under: string[] = [];
  ELEMENTS.forEach(([name, cls], i) => {
    if (i) res.append(el('span', 'sl', '/'));
    const value = n(s, `${name}Resist`);
    const missing = n(s, `Missing${name}Resist`);
    const over = n(s, `${name}ResistOverCap`);
    const v = el('span', cls + (missing > 0 ? ' res-under' : ''), `${fmt(value)}%`);
    v.title = missing > 0 ? `${name}: ${fmt(missing)}% below the cap of ${fmt(value + missing)}%` : `${name}: capped${over > 0 ? `, +${fmt(over)}% over` : ''}`;
    res.append(v);
    if (missing > 0) under.push(`${name} ${fmt(missing)}%`);
  });

  const spiritFree = n(s, 'SpiritUnreserved');
  const def: Row[] = [
    ['Life', el('span', 'c-life', fmt(n(s, 'Life')))],
    ['Energy shield', el('span', 'c-es', fmt(n(s, 'EnergyShield')))],
    ['Mana', el('span', 'c-mana', fmt(n(s, 'Mana')))],
    ['Spirit', el('span', '', el('span', 'c-spirit', fmt(n(s, 'Spirit'))), el('small', '', `${fmt(spiritFree)} free`)), spiritFree < 0 ? 'warn' : ''],
    ['Armour', n(s, 'Armour') ? fmt(n(s, 'Armour')) : '–'],
    ['Evasion rating', n(s, 'Evasion') ? fmt(n(s, 'Evasion')) : '–'],
    ['Evade chance', `${fmt(n(s, 'EvadeChance'))}%`],
  ];
  if (n(s, 'DeflectionRating') > 0) def.push(['Deflection rating', fmt(n(s, 'DeflectionRating'))], ['Deflect chance', `${fmt(n(s, 'DeflectChance'))}%`]);
  if (n(s, 'EffectiveBlockChance') > 0) def.push(['Block chance', `${fmt(n(s, 'EffectiveBlockChance'))}%`]);
  if (n(s, 'PhysicalDamageReduction') > 0) def.push(['Phys. damage reduction', `${fmt(n(s, 'PhysicalDamageReduction'))}%`]);
  def.push(['Resistances', res]);
  if (under.length) def.push(el('div', 'cap-warn', `Below cap: ${under.join(', ')}`));
  if (spiritFree < 0) def.push(el('div', 'cap-warn', `Reservations exceed your Spirit by ${fmt(-spiritFree)}.`));
  def.push(['Effective health pool', compact(n(s, 'TotalEHP'))]);
  def.push([
    'Max hit',
    parts([
      [short(n(s, 'PhysicalMaximumHitTaken')), 'c-phys'],
      [short(n(s, 'FireMaximumHitTaken')), 'c-fire'],
      [short(n(s, 'ColdMaximumHitTaken')), 'c-cold'],
      [short(n(s, 'LightningMaximumHitTaken')), 'c-lightning'],
      [short(n(s, 'ChaosMaximumHitTaken')), 'c-chaos'],
    ]),
  ]);
  rows('st-defensive', def);

  const rec: Row[] = [
    ['Life regen', `${fmt(n(s, 'LifeRegenRecovery'))}/s`],
    ['Mana regen', `${fmt(n(s, 'ManaRegenRecovery'))}/s`],
  ];
  if (n(s, 'LifeLeechGainRate') > 0) rec.push(['Life leech', `${fmt(n(s, 'LifeLeechGainRate'))}/s`]);
  if (n(s, 'ManaLeechGainRate') > 0) rec.push(['Mana leech', `${fmt(n(s, 'ManaLeechGainRate'))}/s`]);
  if (n(s, 'EnergyShield') > 0) {
    rec.push(['Energy shield recharge', `${fmt(n(s, 'EnergyShieldRecharge'))}/s`]);
    rec.push(['Recharge delay', `${fmt(n(s, 'EnergyShieldRechargeDelay'))}s`]);
  }
  rows('st-recovery', rec);

  renderMainSkills(ov.skills);
}

function skillLines(sk: SkillDps): [string, string] {
  const s = sk.stats;
  const first: string[] = [];
  if (s.Speed) first.push(`${fmt(s.Speed)}/s`);
  if (s.CritChance !== undefined) first.push(`${fmt(s.CritChance)}% / ${fmt((s.CritMultiplier ?? 0) * 100)}% crit`);
  if (s.HitChance !== undefined) first.push(`${fmt(s.HitChance)}% hit`);
  const second: string[] = [];
  if (sk.part) second.push(sk.part);
  if (s.ProjectileCount && s.ProjectileCount > 0) second.push(`${fmt(s.ProjectileCount)} proj`);
  if (s.AreaOfEffectRadiusMetres) second.push(`${fmt(s.AreaOfEffectRadiusMetres)}m radius`);
  return [first.join(' · '), second.join(' · ')];
}

function renderMainSkills(skills: SkillDps[]) {
  if (skills.length === 0) {
    $('st-skills').replaceChildren(el('p', 'empty-note', 'No damaging skills found.'));
    return;
  }
  $('st-skills').replaceChildren(
    ...skills.slice(0, 5).map((sk) => {
      const [a, b] = skillLines(sk);
      const box = el('div', `main-skill${sk.main ? ' main' : ''}`, el('span', 'n', sk.name), el('span', 'd', compact(sk.dps)), a && el('span', 's', a), b && el('span', 's', b));
      box.title = sk.main ? 'Main skill of the build' : 'DPS if this were the main skill';
      return box;
    }),
  );
}

// ---------- Header ----------

/** "forbiddenrites" → "Forbiddenrites"; poe.ninja's URL names have no spaces. */
const leagueName = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1);

function renderHeader(v: BuildView, ov: Overview) {
  const b = v.build;
  const src = b?.source;
  const cls = ov.ascendancy && ov.ascendancy !== 'None' ? ov.ascendancy : ov.className ?? '';
  $('p-league').textContent =
    src?.kind === 'ninja' ? `${b?.leagueName ?? leagueName(src.league)} league` : src?.kind === 'file' ? 'Path of Building 2 file' : 'From a Path of Building code';
  $('p-name').textContent = src?.kind === 'ninja' ? src.character : src?.kind === 'file' ? src.name : cls || 'Character';
  $('p-class').replaceChildren(el('b', '', `Level ${ov.level ?? '?'}`), ` ${cls}`);

  const meta: [string, string, boolean?][] = [];
  if (src?.kind === 'ninja') meta.push(['Account', src.account.replace(/-(\d+)$/, '#$1')]);
  if (b) {
    const when = src?.kind === 'paste' ? b.importedAt : b.snapshotAt ?? b.importedAt;
    const label = src?.kind === 'ninja' ? 'Last fetched' : src?.kind === 'file' ? 'Saved in PoB' : 'Pasted';
    meta.push([label, ageText(when), isStale(when)]);
    if (src?.kind === 'ninja') meta.push(['Loaded', ageText(b.importedAt)]);
    if (src?.kind === 'file') meta.push(['Updates', 'on every save']);
  }
  $('p-meta').replaceChildren(...meta.map(([k, val, stale]) => el('div', '', el('dt', '', k), el('dd', stale ? 'stale' : '', val + (stale ? ' · import again?' : '')))));
  $('hero-refresh').hidden = !(v.settings.ninja && src?.kind === 'ninja');

  const equips = b?.equips ?? [];
  $('local-changes').hidden = equips.length === 0;
  $('local-changes-text').textContent = `${equips.length} item${equips.length === 1 ? '' : 's'} changed since`;
  $('local-changes').title = equips.map((e) => `${e.slot}: ${e.name} (${ageText(e.at)})`).join('\n');
}

// ---------- Item check page ----------

function renderHotkey(v: BuildView) {
  if (recording) return;
  $('hk-keys').className = 'hk-keys';
  $('hk-keys').replaceChildren(
    ...formatHotkey(v.settings.hotkey).flatMap((k, i) => [i ? el('span', 'plus', '+') : '', el('kbd', 'key lg', k)]).filter((x): x is HTMLElement => x !== ''),
  );
  const state = $('hk-state');
  state.textContent = v.hotkeyActive ? 'active' : 'not active – used by another program';
  state.style.color = v.hotkeyActive ? 'var(--ok)' : '#f0a597';
}

let recording = false;
function startRecording() {
  recording = true;
  $('hk-error').textContent = '';
  $('hk-keys').className = 'hk-keys recording';
  $('hk-keys').textContent = 'Press the new key combination… (Esc to cancel)';
  $('hk-record').textContent = 'Cancel';
}
function stopRecording() {
  recording = false;
  $('hk-record').textContent = 'Change';
  if (current) renderHotkey(current);
}
window.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  if (e.key === 'Escape') return stopRecording();
  const acc = acceleratorFromEvent(e);
  if (!acc) return; // only modifiers so far
  const problem = validateHotkey(acc);
  if (problem) {
    $('hk-error').textContent = problem;
    return;
  }
  void api.setHotkey(acc).then((r) => {
    stopRecording();
    if (!r.ok) $('hk-error').textContent = r.error;
    render(r.view);
    if (r.ok) message(`Item check hotkey is now ${formatHotkey(acc).join('+')}.`);
  });
});

// ---------- Render ----------

// ---------- KI-Verbindung (optional) ----------

let mcpLoaded = false;
function renderMcp(v: BuildView) {
  const on = !!v.settings.mcp;
  $<HTMLInputElement>('mcp-on').checked = on;
  const badge = $('mcp-badge');
  badge.textContent = on ? 'on' : 'off';
  badge.classList.toggle('on', on);
  $('mcp-setup-card').classList.toggle('dim', !on);
  if (!mcpLoaded) {
    mcpLoaded = true;
    void api.mcpSetup().then((s) => {
      $('mcp-json').textContent = s.json;
      $('mcp-cc').textContent = s.claudeCode;
    });
  }
}
$('mcp-on').addEventListener('change', (e) => void api.setMcp((e.target as HTMLInputElement).checked));
for (const [btn, what] of [['mcp-copy-json', 'json'], ['mcp-copy-cc', 'claudeCode']] as const) {
  $(btn).addEventListener('click', () => void api.copyMcp(what).then(() => message('Copied – paste it into your AI program.')));
}

function render(v: BuildView) {
  renderMcp(v);
  if (v.build?.code !== current?.build?.code) shownSet = null;
  current = v;
  localSlots = new Set((v.build?.equips ?? []).map((e) => e.slot));
  renderHotkey(v);

  const engine = $('engine-state');
  engine.className = `engine-state ${v.engine}`;
  engine.querySelector('span')!.textContent =
    v.engine === 'ready' ? 'Path of Building ready' : v.engine === 'failed' ? 'Path of Building failed to start' : 'Starting Path of Building…';
  if (v.engineError) message(v.engineError, 'error');

  const ov = v.overview;
  $('empty').hidden = !!v.build || v.engine === 'starting';
  $('char').hidden = !ov;

  renderUpgradeSlots(v);
  if (ov) {
    renderHeader(v, ov);
    renderEquipment(ov, v.build?.icons ?? []);
    renderStats(ov);
    renderGemGroups(ov);
    renderPassives(ov);
  }

  // Build source page
  const ninja = v.settings.ninja;
  $('ninja-current').hidden = !ninja;
  if (ninja) {
    $('ninja-name').textContent = `${ninja.character} · ${ninja.account}`;
    const b = v.build?.source.kind === 'ninja' ? v.build : undefined;
    $('ninja-meta').textContent = `League ${ninja.league}` + (b ? ` · loaded ${ageText(b.importedAt)}` : ' · not loaded yet');
  }
  renderPobFiles();
  renderTarget(v);
}

// ---------- Target build ----------

const fitClass = (have: number, total: number) => (total === 0 ? 'off' : have / total >= 0.67 ? 'good' : have / total >= 0.34 ? 'some' : 'off');

function renderTarget(v: BuildView) {
  const t = v.target;
  $('target-current').hidden = !t;
  $('target-intro').hidden = !!t;
  $('target-paste').textContent = t ? 'Replace with code from clipboard' : 'Paste target code';
  $('target-progress-card').hidden = !t || !v.overview;
  if (t) {
    $('target-name').textContent = t.name;
    const who = [t.build.ascendancy ?? t.build.className, t.build.level ? `level ${t.build.level}` : ''].filter(Boolean).join(' ');
    $('target-meta').textContent = [who, t.source === 'file' ? 'from a PoB 2 file' : t.source === 'link' ? 'from a link' : 'from a pasted code', `set ${ageText(t.importedAt)}`].filter(Boolean).join(' · ');
  }
  $('target-note').textContent = t ? `${t.build.slots.length} slots with target items` : '';
  renderTargetFiles();
  if (!t || !v.overview) return;

  const ov = v.overview;
  const gear = new Map(ov.gear.map((g) => [g.slot, g.item]));
  let sumHave = 0;
  let sumTotal = 0;
  const rows = t.build.slots.map((ts) => {
    const mine = ts.slot.startsWith('Weapon') && ov.weaponSet === 2 ? gear.get(`${ts.slot} Swap`) : gear.get(ts.slot);
    const targetRarity = `rarity-${ts.rarity.toLowerCase()}`;
    const names = el(
      'div',
      'names',
      'Target ',
      el('b', targetRarity, ts.name),
      ts.unique ? '' : ` (${ts.base})`,
      ' · yours ',
      mine ? el('b', `rarity-${mine.rarity.toLowerCase()}`, mine.title ?? mine.base) : el('b', '', 'empty'),
    );
    const fit = mine ? fitAgainst(ts, mine) : null;
    const chips = el('div', 'chips');
    const counted = ts.wanted.filter((w) => !w.minor).length;
    let have = 0;
    for (const w of ts.wanted) {
      const hit = fit?.have.find((h) => h.key === w.key);
      if (hit && !w.minor) have++;
      const vals = hit?.itemValue !== undefined && w.value !== undefined ? `${fmt(hit.itemValue)} / ${fmt(w.value)}` : w.value !== undefined && !hit ? fmt(w.value) : '';
      const chip = el('span', `chip ${hit ? 'has' : 'miss'}${w.minor ? ' minor' : ''}`, `${hit ? '✓' : '✗'} ${w.label}`, vals && el('small', '', vals));
      chip.title = hit ? `Your item has it${vals ? ` (yours / target: ${vals})` : ''}` : `Missing${w.value !== undefined ? ` – target item: ${fmt(w.value)}` : ''}`;
      chips.append(chip);
    }
    sumHave += have;
    sumTotal += counted;
    const score = el('div', `score ${fitClass(have, counted)}`, counted ? `${have}/${counted}` : '–');
    return el('div', 'target-row', el('div', 'slot', ts.slot), el('div', '', names, chips), score);
  });
  const bar = el('div', 'progress-bar', el('i'));
  (bar.firstChild as HTMLElement).style.width = `${sumTotal ? Math.round((sumHave / sumTotal) * 100) : 0}%`;
  $('target-rows').replaceChildren(bar, ...rows);
  $('target-progress-note').textContent = `${sumHave} of ${sumTotal} target stats (${sumTotal ? Math.round((sumHave / sumTotal) * 100) : 0}%)`;
}

function renderTargetFiles() {
  const box = $('target-files');
  if (!pobFiles || pobFiles.files.length === 0) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(
    el('p', 'card-note', 'Or use a build saved in Path of Building 2:'),
    ...pobFiles.files.slice(0, 6).map((f) => {
      const isTarget = current?.target?.source === 'file' && current.target.name === f.name;
      const info = [f.level ? `Level ${f.level}` : '', f.className ?? '', `saved ${ageText(f.savedAt)}`].filter(Boolean).join(' · ');
      const action = isTarget
        ? el('span', 'watching', '● Target')
        : (() => {
            const b = el('button', 'btn sm', 'Use as target');
            b.addEventListener('click', () => void run(b, () => api.useTargetFile(f.path), `${f.name} is now your target build.`));
            return b;
          })();
      return el('div', `pob-file${isTarget ? ' current' : ''}`, el('div', '', el('b', '', f.name), el('small', '', info)), action);
    }),
  );
}

// ---------- Path of Building 2 files ----------

let pobFiles: { dir: string; files: PobFileEntry[] } | null = null;

async function loadPobFiles() {
  pobFiles = await api.listPobFiles();
  renderPobFiles();
  renderTargetFiles();
}

function renderPobFiles() {
  if (!pobFiles) return;
  const using = current?.build?.source.kind === 'file' ? current.build.source.path : null;
  $('pob-dir').textContent = pobFiles.dir;
  $('pob-dir').title = pobFiles.dir;
  if (pobFiles.files.length === 0) {
    $('pob-files').replaceChildren(el('p', 'empty-note', 'No Path of Building 2 builds found in this folder yet. Save your build in PoB (Ctrl+S) and click "Refresh list", or choose the file.'));
    return;
  }
  $('pob-files').replaceChildren(
    ...pobFiles.files.slice(0, 8).map((f) => {
      const isCurrent = f.path === using;
      const info = [f.level ? `Level ${f.level}` : '', f.className ?? '', `saved ${ageText(f.savedAt)}`].filter(Boolean).join(' · ');
      let action: HTMLElement;
      if (isCurrent) {
        action = el('span', 'watching', '● Watching');
      } else {
        const b = el('button', 'btn sm primary', 'Use');
        b.addEventListener('click', () =>
          void run(b, () => api.usePobFile(f.path), `Loaded ${f.name} – it reloads whenever you save it in Path of Building.`).then(() => {
            if (current?.build?.source.kind === 'file') showPage('character');
          }),
        );
        action = b;
      }
      return el('div', `pob-file${isCurrent ? ' current' : ''}`, el('div', '', el('b', '', f.name), el('small', '', info)), action);
    }),
  );
}

// ---------- Actions ----------

$('pob-reload-list').addEventListener('click', () => void loadPobFiles());
$('pob-folder').addEventListener('click', () => void api.openPobFolder());
$<HTMLButtonElement>('pob-choose').addEventListener('click', (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  void api.choosePobFile().then((res) => {
    if (!res) return; // cancelled
    render(res.view);
    if (res.ok) {
      message('Build file loaded – it reloads whenever you save it in Path of Building.');
      showPage('character');
    } else message(res.error, 'error');
    void loadPobFiles();
    btn.blur();
  });
});
// The list is read when the page is opened (files change while the app runs).
document.querySelector('.nav-item[data-page=source]')?.addEventListener('click', () => void loadPobFiles());
document.querySelector('.nav-item[data-page=target]')?.addEventListener('click', () => void loadPobFiles());
$<HTMLButtonElement>('target-paste').addEventListener('click', (e) =>
  void run(e.currentTarget as HTMLButtonElement, () => api.pasteTarget(), 'Target build set – the item check now also shows whether an item fits it.'),
);
$<HTMLButtonElement>('target-link-use').addEventListener('click', (e) => {
  const link = $<HTMLInputElement>('target-link').value.trim();
  void run(e.currentTarget as HTMLButtonElement, () => api.linkTarget(link), 'Target build set from the link – the item check now also shows whether an item fits it.').then(() => {
    if (current?.target?.source === 'link') $<HTMLInputElement>('target-link').value = '';
  });
});
$<HTMLInputElement>('target-link').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('target-link-use').click();
});
$<HTMLButtonElement>('target-clear').addEventListener('click', (e) => void run(e.currentTarget as HTMLButtonElement, () => api.clearTarget(), 'Target build removed.'));
api.onNotice((n) => message(n.text, n.kind));

$('hk-record').addEventListener('click', () => (recording ? stopRecording() : startRecording()));
$('overlay-reset').addEventListener('click', () => void api.resetOverlayPosition().then(() => message('The overlay appears next to the cursor again.')));
$<HTMLButtonElement>('reset-equips').addEventListener('click', (e) =>
  void run(e.currentTarget as HTMLButtonElement, () => api.resetEquips(), 'Local item changes were undone.'),
);

const paste = (btn: HTMLButtonElement) => run(btn, () => api.pasteBuild(), 'Build code loaded.');
for (const id of ['empty-paste', 'hero-paste', 'source-paste']) {
  const b = $<HTMLButtonElement>(id);
  b.addEventListener('click', () => void paste(b).then(() => current?.overview && showPage('character')));
}

$('hero-copy').addEventListener('click', () =>
  void api.copyBuild().then((ok) => message(ok ? 'Build code copied – paste it into Path of Building (Import/Export Build).' : 'No build loaded.', ok ? 'ok' : 'error')),
);

const refresh = (btn: HTMLButtonElement) => run(btn, () => api.refreshNinja(), 'Loaded the latest state from poe.ninja.');
$<HTMLButtonElement>('hero-refresh').addEventListener('click', (e) => void refresh(e.currentTarget as HTMLButtonElement));
$<HTMLButtonElement>('ninja-refresh').addEventListener('click', (e) => void refresh(e.currentTarget as HTMLButtonElement));

for (const b of document.querySelectorAll<HTMLButtonElement>('#set-toggle button')) {
  b.addEventListener('click', () => {
    shownSet = Number(b.dataset.set);
    if (current?.overview) renderEquipment(current.overview, current.build?.icons ?? []);
  });
}

const linkInput = $<HTMLInputElement>('ninja-link');
const connect = () =>
  run($<HTMLButtonElement>('ninja-save'), () => api.setNinjaLink(linkInput.value), 'Connected – your character was loaded from poe.ninja.').then(() => {
    if (current?.settings.ninja) linkInput.value = '';
  });
$('ninja-save').addEventListener('click', () => void connect());
linkInput.addEventListener('keydown', (e) => e.key === 'Enter' && void connect());
$('ninja-clear').addEventListener('click', () => void api.clearNinja().then((r) => render(r.view)));
$('ninja-open').addEventListener('click', () => void api.openNinja());

// ---------- Upgrades page ----------

const UP_FORM_KEY = 'upgrades-form';
interface UpForm { budget: number; currency: 'divine' | 'exalted'; dpsWeight: number; instantOnly: boolean; wornMinimum: boolean; slots?: string[] }
let upForm: UpForm = { budget: 2, currency: 'divine', dpsWeight: 0.5, instantOnly: true, wornMinimum: false };
try {
  const saved = JSON.parse(localStorage.getItem(UP_FORM_KEY) ?? 'null') as Partial<UpForm> | null;
  if (saved) upForm = { ...upForm, ...saved };
} catch {
  // nur eine Bequemlichkeit
}
const saveUpForm = () => {
  try {
    localStorage.setItem(UP_FORM_KEY, JSON.stringify(upForm));
  } catch {
    // egal
  }
};
let upRun: UpgradeRun = { running: false, results: [] };

/** Default: slots with a rare/magic item or empty – uniques are often what the build is made of. */
function defaultSlots(ov: Overview): string[] {
  return UPGRADE_SLOTS.filter((s) => {
    const g = ov.gear.find((x) => x.slot === s);
    return !g?.item || (g.item.rarity !== 'UNIQUE' && g.item.rarity !== 'RELIC');
  });
}

function chosenSlots(): string[] {
  const ov = current?.overview;
  return ov ? (upForm.slots ?? defaultSlots(ov)) : [];
}

/** Small item picture (or an empty frame); falls back to nothing if the image fails. */
function thumb(item: ItemInfo | null, url: string | undefined): HTMLElement {
  const box = el('span', `up-thumb${item ? ` ${rarityCls(item)}` : ''}`);
  if (url) {
    const img = el('img');
    img.src = url;
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    box.append(img);
  } else if (!item) {
    box.append(el('i', 'ph'));
  }
  return box;
}

const gearItem = (slot: string) => current?.overview?.gear.find((g) => g.slot === slot)?.item ?? null;
const gearThumb = (slot: string) => {
  const item = gearItem(slot);
  return thumb(item, item ? iconFor(item, slot, current?.build?.icons ?? []) : undefined);
};

function renderUpgradeSlots(v: BuildView) {
  const ov = v.overview;
  const box = $('up-slots');
  box.replaceChildren();
  if (!ov) {
    box.append(el('p', 'up-msg', 'Load your build first.'));
    updateUpNote();
    return;
  }
  // Wessen DPS zählt – wichtig, wenn PoB keinen Hauptskill mit Schaden ausgewählt hat.
  const main = ov.skills.find((k) => k.main) ?? ov.skills[0];
  const skillNote = $('up-skill');
  skillNote.hidden = !main;
  if (main) {
    skillNote.replaceChildren(
      'Damage counts for ',
      el('b', '', main.name),
      ov.mainSkillAuto ? ' – picked automatically: the main skill selected in Path of Building does no damage.' : ' (your main skill in Path of Building).',
    );
  }
  const chosen = new Set(chosenSlots());
  for (const slot of UPGRADE_SLOTS) {
    const item = gearItem(slot);
    const b = el(
      'button',
      `up-slot${chosen.has(slot) ? ' on' : ''}`,
      gearThumb(slot),
      el('span', 'up-slot-text', el('span', 's1', slot), el('span', `s2${item ? ` ${rarityCls(item)}` : ''}`, item ? (item.title ?? item.name) : 'empty')),
    );
    b.setAttribute('aria-pressed', String(chosen.has(slot)));
    b.addEventListener('click', () => {
      const now = new Set(chosenSlots());
      if (now.has(slot)) now.delete(slot);
      else now.add(slot);
      setSlots([...now]);
    });
    box.append(b);
  }
  updateUpNote();
}

function setSlots(slots: string[]) {
  upForm.slots = UPGRADE_SLOTS.filter((s) => slots.includes(s));
  saveUpForm();
  if (current) renderUpgradeSlots(current);
}

function updateUpNote() {
  const n = chosenSlots().length;
  $('up-note').textContent = upRun.running
    ? ''
    : n
      ? `${n} slot${n === 1 ? '' : 's'} · up to ${n * 2} trade searches${n > 6 ? ' – a second full run right after may hit the trade site’s limit' : ''}`
      : 'Pick at least one slot.';
  $<HTMLButtonElement>('up-start').disabled = upRun.running || n === 0 || !current?.overview;
}

const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
const tone = (n: number) => (n >= 0.5 ? 'pos' : n <= -0.5 ? 'neg' : 'zero');
const CUR_SHORT: Record<string, string> = { divine: 'div', exalted: 'ex', chaos: 'chaos' };

function priceCell(c: UpgradeCandidate): HTMLElement {
  if (!c.price) return el('span', 'price', '–');
  return el('span', `price cur-${c.price.currency}`, fmt(c.price.amount), el('small', '', CUR_SHORT[c.price.currency] ?? c.price.currency));
}

function candidateRow(c: UpgradeCandidate): HTMLElement {
  const hasTitle = !!c.item.title && c.item.title !== c.item.base;
  const name = el('span', `name rarity-${c.item.rarity.toLowerCase()}`, hasTitle ? c.item.title! : c.item.base);
  const subText = c.blocking.length
    ? el('span', 'sub why', `✗ ${c.blocking.join(' · ')}`)
    : c.warnings.length
      ? el('span', 'sub why soft', `⚠ ${c.warnings.join(' · ')}`)
      : el('span', 'sub', [hasTitle ? c.item.base : '', c.listedAt ? `listed ${ageText(c.listedAt)}` : ''].filter(Boolean).join(' · '));
  const who = el('span', 'who', name, subText);
  attachTooltip(who, c.item);
  const row = el(
    'div',
    `up-cand ${c.upgrade ? 'good' : 'meh'}`,
    thumb(c.item, c.icon),
    who,
    priceCell(c),
    el('span', `num ${tone(c.dpsPct)}`, signed(c.dpsPct)),
    el('span', `num ${tone(c.ehpPct)}`, signed(c.ehpPct)),
    el('span', `gain ${tone(c.gain)}`, signed(c.gain)),
    el('span', 'open', c.tradeUrl ? '↗' : ''),
  );
  if (c.tradeUrl) {
    // Ganze Zeile klickbar: öffnet die Trade-Seite (im Browser) mit genau diesem Angebot oben.
    const url = c.tradeUrl;
    row.classList.add('clickable');
    row.title = 'Open this listing on the trade site';
    row.tabIndex = 0;
    const open = () => window.open(url, '_blank');
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open()));
  }
  return row;
}

const COLS = () =>
  el('div', 'up-cols', el('span', ''), el('span', '', 'Item'), el('span', '', 'Price'), el('span', '', 'DPS'), el('span', '', 'eHP'), el('span', '', 'Overall'), el('span', ''));

/** Upgrades only show the closest few others; without an upgrade the closest listings are shown. */
const OTHERS_WITH_UPGRADE = 2;

function slotResult(r: UpgradeSlotResult): HTMLElement {
  const ups = r.candidates.filter((c) => c.upgrade);
  const others = r.candidates.filter((c) => !c.upgrade);
  const best = ups[0];

  const sub = el('div', 'up-slot-sub');
  if (r.current) sub.append(el('span', 'cur', r.current), ' · ');
  sub.append(r.error ? 'search failed' : `${fmt(r.total)} listing${r.total === 1 ? '' : 's'} · ${r.evaluated} calculated${r.priceLevels && r.priceLevels > 1 ? ` from ${r.priceLevels} price levels` : ''}${r.overBudget ? ` · ${r.overBudget} over budget left out` : ''}`);

  const head = el(
    'div',
    'up-slot-head',
    gearThumb(r.slot),
    el('div', '', el('div', 'up-slot-title', r.slot), sub),
    r.error ? el('span', '') : best ? el('span', 'up-best yes', `Best ${signed(best.gain)}`) : el('span', 'up-best no', 'No upgrade in budget'),
  );
  const link = (cls: string, text: string, url: string, title: string) => {
    const a = el('a', cls, text);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.title = title;
    return a;
  };
  const links = el('span', 'up-links');
  if (r.weightedUrl) {
    links.append(
      link(
        'btn sm up-weighted',
        'Weighted search ↗',
        r.weightedUrl,
        "Path of Building's weighted search on the trade site: every mod weighted for your build, only items that score higher than yours, within the budget, best first. Opens in your browser – sign in on the trade site there.",
      ),
    );
  }
  if (r.tradeUrl) links.append(link('btn sm ghost', 'Our search ↗', r.tradeUrl, 'The search these listings come from'));
  head.append(links);

  const card = el('section', `card up-slot-card${best ? ' has-upgrade' : ''}`, head);
  if (r.searched?.length) {
    card.append(el('div', 'up-searched', el('span', 'up-label', 'Searched for'), ...r.searched.map((x) => el('span', 'chip', x))));
  }
  if (r.error) {
    card.append(el('p', 'up-msg error', r.error));
    return card;
  }
  if (r.candidates.length === 0) {
    card.append(el('p', 'up-msg', r.total ? 'None of the listings within the budget could be calculated.' : 'Nothing within the budget has enough of the mods your build needs.'));
    return card;
  }
  card.append(COLS());
  if (ups.length) {
    card.append(el('div', 'up-list', ...ups.map(candidateRow)));
    if (others.length) card.append(el('div', 'up-divider', 'Closest others'), el('div', 'up-list', ...others.slice(0, OTHERS_WITH_UPGRADE).map(candidateRow)));
  } else {
    card.append(el('div', 'up-list', ...others.map(candidateRow)));
  }
  return card;
}

const STEP_TEXT = {
  weights: 'Path of Building weighs the mods',
  search: 'searching the trade site',
  fetch: 'loading listings',
  evaluate: 'calculating in your build',
  wait: 'waiting for the trade site',
} as const;
const STEP_SHARE = { weights: 0.1, search: 0.3, wait: 0.3, fetch: 0.6, evaluate: 0.9 } as const;

function renderUpgrades(r: UpgradeRun) {
  upRun = r;
  $('up-cancel').hidden = !r.running;
  const p = r.progress;
  const progress = $('up-progress');
  progress.replaceChildren();
  if (r.running) {
    if (p) progress.append(el('b', '', `${p.slot}`), ` (${p.index + 1} of ${p.count}) – ${STEP_TEXT[p.step]}${p.step === 'wait' && p.waitS ? `, ${p.waitS} s` : ''}…`);
    else progress.append('Starting…');
  } else if (r.league) {
    progress.append(`Searched ${r.results.length} slot${r.results.length === 1 ? '' : 's'} in ${r.league}`);
  }
  if (r.budgetExalted && r.exaltedPerDivine && r.league) progress.append(` · budget ${fmt(r.budgetExalted)} ex (1 div = ${fmt(r.exaltedPerDivine)} ex)`);
  const meter = $('up-meter');
  meter.hidden = !r.running;
  $('up-meter-fill').style.width = p ? `${Math.round(((p.index + STEP_SHARE[p.step]) / p.count) * 100)}%` : '3%';
  updateUpNote();
  if (r.error && !r.running) message(r.error, 'error');

  // Zusammenfassung über alle Slots.
  const summary = $('up-summary');
  const found = r.results.flatMap((x) => x.candidates.filter((c) => c.upgrade).map((c) => ({ slot: x.slot, c })));
  summary.hidden = r.results.length === 0 || r.running;
  if (!summary.hidden) {
    const top = [...found].sort((a, b) => b.c.gain - a.c.gain)[0];
    summary.className = `up-summary${found.length ? ' found' : ''}`;
    summary.replaceChildren(
      el('span', 'big', found.length ? `${found.length} upgrade${found.length === 1 ? '' : 's'}` : 'No upgrades'),
      el(
        'span',
        '',
        found.length
          ? `in ${new Set(found.map((f) => f.slot)).size} of ${r.results.length} slots · best: ${top.slot} ${signed(top.c.gain)}${top.c.price ? ` for ${fmt(top.c.price.amount)} ${CUR_SHORT[top.c.price.currency] ?? top.c.price.currency}` : ''}`
          : 'within this budget – try a higher budget or other slots.',
      ),
    );
  }
  // Slots mit Upgrade zuerst (bester Gewinn zuerst), sonst in Suchreihenfolge.
  const bestGain = (x: UpgradeSlotResult) => x.candidates.find((c) => c.upgrade)?.gain ?? -Infinity;
  const sorted = [...r.results].sort((a, b) => bestGain(b) - bestGain(a));
  $('up-results').replaceChildren(...sorted.map(slotResult));
}

function syncUpForm() {
  $<HTMLInputElement>('up-budget').value = String(upForm.budget);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#up-currency button')) b.classList.toggle('active', b.dataset.cur === upForm.currency);
  const d = Math.round(upForm.dpsWeight * 100);
  $<HTMLInputElement>('up-weight').value = String(d);
  $('up-def-text').replaceChildren('Defence ', el('b', '', `${100 - d}%`));
  $('up-dmg-text').replaceChildren(el('b', '', `${d}%`), ' Damage');
  $<HTMLInputElement>('up-instant').checked = upForm.instantOnly;
  $<HTMLInputElement>('up-worn').checked = upForm.wornMinimum;
}
syncUpForm();

$('up-budget').addEventListener('input', (e) => {
  const n = Number((e.target as HTMLInputElement).value);
  if (Number.isFinite(n) && n > 0) {
    upForm.budget = n;
    saveUpForm();
  }
});
for (const b of document.querySelectorAll<HTMLButtonElement>('#up-currency button')) {
  b.addEventListener('click', () => {
    upForm.currency = b.dataset.cur === 'exalted' ? 'exalted' : 'divine';
    saveUpForm();
    syncUpForm();
  });
}
$('up-weight').addEventListener('input', (e) => {
  upForm.dpsWeight = Number((e.target as HTMLInputElement).value) / 100;
  saveUpForm();
  syncUpForm();
});
$('up-instant').addEventListener('change', (e) => {
  upForm.instantOnly = (e.target as HTMLInputElement).checked;
  saveUpForm();
});
$('up-worn').addEventListener('change', (e) => {
  upForm.wornMinimum = (e.target as HTMLInputElement).checked;
  saveUpForm();
});
$('up-all').addEventListener('click', () => setSlots([...UPGRADE_SLOTS]));
$('up-none-btn').addEventListener('click', () => setSlots([]));
$('up-start').addEventListener('click', () => {
  if (!current?.overview || upRun.running) return;
  const budget = Number($<HTMLInputElement>('up-budget').value);
  if (!(budget > 0)) {
    message('Enter a budget per item.', 'error');
    return;
  }
  message('');
  void api
    .startUpgrades({ budget, currency: upForm.currency, slots: chosenSlots(), dpsWeight: upForm.dpsWeight, instantOnly: upForm.instantOnly, wornMinimum: upForm.wornMinimum })
    .then(renderUpgrades);
});
$('up-cancel').addEventListener('click', () => api.cancelUpgrades());
api.onUpgrades(renderUpgrades);
void api.getUpgrades().then(renderUpgrades);

api.onView(render);
void api.getView().then(render);
// Keep the "x hours ago" texts current.
setInterval(() => current?.overview && renderHeader(current, current.overview), 60_000);
