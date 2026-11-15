import type { Api } from '../main/preload';
import type { BuildView, GearSlot, ItemIcon, ItemInfo, Overview, SkillDps, Stats } from '../shared/types';
import { acceleratorFromEvent, formatHotkey, validateHotkey } from '../shared/hotkey';
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

function iconFor(item: ItemInfo, slot: string, icons: ItemIcon[]): string | undefined {
  const byName = icons.find((i) => i.name === item.name);
  // A locally equipped item has no picture of its own – never show the replaced item's picture.
  if (byName || localSlots.has(slot)) return byName?.url;
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
  $('p-league').textContent = src?.kind === 'ninja' ? `${b?.leagueName ?? leagueName(src.league)} league` : 'From a Path of Building code';
  $('p-name').textContent = src?.kind === 'ninja' ? src.character : cls || 'Character';
  $('p-class').replaceChildren(el('b', '', `Level ${ov.level ?? '?'}`), ` ${cls}`);

  const meta: [string, string, boolean?][] = [];
  if (src?.kind === 'ninja') meta.push(['Account', src.account.replace(/-(\d+)$/, '#$1')]);
  if (b) {
    const when = src?.kind === 'ninja' ? b.snapshotAt ?? b.importedAt : b.importedAt;
    meta.push([src?.kind === 'ninja' ? 'Last fetched' : 'Pasted', ageText(when), isStale(when)]);
    if (src?.kind === 'ninja') meta.push(['Loaded', ageText(b.importedAt)]);
  }
  $('p-meta').replaceChildren(...meta.map(([k, val, stale]) => el('div', '', el('dt', '', k), el('dd', stale ? 'stale' : '', val + (stale ? ' · refresh?' : '')))));
  $('hero-refresh').hidden = !v.settings.ninja;

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

function render(v: BuildView) {
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
}

// ---------- Actions ----------

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

api.onView(render);
void api.getView().then(render);
// Keep the "x hours ago" texts current.
setInterval(() => current?.overview && renderHeader(current, current.overview), 60_000);
