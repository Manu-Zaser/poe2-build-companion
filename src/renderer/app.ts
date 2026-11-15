import type { Api } from '../main/preload';
import type { BuildView, ItemInfo, Overview, Stats } from '../shared/types';
import { ageText, compact, fmt, isStale } from './format';

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

function message(text: string, kind: 'ok' | 'error' | 'warn' = 'ok') {
  const box = $('msg');
  box.textContent = text;
  box.className = `banner${kind === 'ok' ? '' : ` ${kind}`}`;
  box.hidden = !text;
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

// ---------- Rendering ----------

const SLOT_LABELS: Record<string, string> = {
  'Weapon 1': 'Main hand',
  'Weapon 2': 'Off hand',
  'Weapon 1 Swap': 'Main hand',
  'Weapon 2 Swap': 'Off hand',
  'Body Armour': 'Body armour',
  'Ring 1': 'Left ring',
  'Ring 2': 'Right ring',
};
const slotLabel = (slot: string) => SLOT_LABELS[slot] ?? slot;

function itemCard(slot: string, item: ItemInfo | null): HTMLElement {
  if (!item) return el('div', 'slot empty', el('div', 'slot-label', slotLabel(slot)), 'Empty');
  const rarity = `rarity-${item.rarity.toLowerCase()}`;
  const mods = el('ul', 'mods');
  let lastKind = '';
  for (const m of item.mods) {
    const group = m.kind === 'explicit' || m.kind === 'unique' ? 'main' : 'pre';
    if (lastKind && group !== lastKind) mods.append(el('li', 'sep'));
    lastKind = group;
    const li = el('li', m.kind + (m.inactive ? ' inactive' : ''), m.text);
    if (m.inactive) li.title = 'Path of Building does not use this line in its calculation';
    mods.append(li);
  }
  const hasTitle = item.title && item.title !== item.base;
  return el(
    'div',
    'slot',
    el('div', 'slot-label', el('span', '', slotLabel(slot)), item.corrupted && el('span', 'corrupted', 'Corrupted')),
    el('div', `slot-name ${rarity}`, hasTitle ? item.title! : item.base),
    hasTitle && el('div', 'slot-base', item.base),
    item.mods.length > 0 && mods,
  );
}

function kpi(cls: string, label: string, value: string, sub?: string, title?: string) {
  const k = el('div', `kpi ${cls}`, el('span', '', label), el('strong', '', value), sub && el('small', '', sub));
  if (title) k.title = title;
  return k;
}

const n = (s: Stats, k: string) => s[k] ?? 0;

function renderKpis(ov: Overview) {
  const s = ov.stats;
  const spiritFree = n(s, 'SpiritUnreserved');
  const spirit = kpi('spirit', 'Spirit', fmt(n(s, 'Spirit')), `${fmt(spiritFree)} unreserved`);
  if (spiritFree < 0) spirit.classList.add('warn');
  const dps = n(s, 'CombinedDPS') || n(s, 'TotalDPS');
  $('kpis').replaceChildren(
    kpi('life', 'Life', fmt(n(s, 'Life'))),
    kpi('es', 'Energy Shield', fmt(n(s, 'EnergyShield'))),
    kpi('mana', 'Mana', fmt(n(s, 'Mana'))),
    spirit,
    kpi('ehp', 'Effective HP', fmt(n(s, 'TotalEHP')), `max phys hit ${fmt(n(s, 'PhysicalMaximumHitTaken'))}`, 'Effective Health Pool as calculated by Path of Building'),
    kpi('dps', 'DPS', compact(dps), ov.mainSkill ?? '', 'Combined DPS of the main skill'),
  );
}

const ELEMENTS = [
  ['Fire', 'fire'],
  ['Cold', 'cold'],
  ['Lightning', 'lightning'],
  ['Chaos', 'chaos'],
] as const;

function renderResistances(s: Stats) {
  let below = 0;
  const rows = ELEMENTS.map(([name, cls]) => {
    const value = n(s, `${name}Resist`);
    const missing = n(s, `Missing${name}Resist`);
    const over = n(s, `${name}ResistOverCap`);
    const max = value + missing;
    if (missing > 0) below++;
    const pct = (v: number) => `${Math.max(0, Math.min(100, v))}%`;
    const bar = el('div', 'res-bar', el('i'), el('b'));
    (bar.firstChild as HTMLElement).style.width = pct(value);
    (bar.lastChild as HTMLElement).style.left = pct(max);
    const note =
      missing > 0 ? el('small', 'miss', `${fmt(missing)} below cap`) : over > 0 ? el('small', 'over', `+${fmt(over)} over cap`) : el('small', 'ok', 'capped');
    const row = el('div', `res-row ${cls}`, el('span', 'res-name', name), bar, el('div', 'res-val', el('strong', '', `${fmt(value)}%`), ` / ${fmt(max)}%`, note));
    row.title = `${name}: ${fmt(n(s, `${name}ResistTotal`))}% before the cap, maximum ${fmt(max)}%`;
    return row;
  });
  $('res-list').replaceChildren(...rows);
  const note = $('res-note');
  note.textContent = below === 0 ? 'all capped' : `${below} below cap`;
  note.style.color = below === 0 ? 'var(--ok)' : '#f0a597';
}

function renderSkills(ov: Overview) {
  const list = $('skills');
  const skills = ov.skills.filter((sk) => sk.dps > 0).slice(0, 8);
  if (skills.length === 0) {
    list.replaceChildren(el('li', 'empty-note', 'No damaging skills found in this build.'));
    $('dps-note').textContent = '';
    return;
  }
  const top = skills[0].dps;
  list.replaceChildren(
    ...skills.map((sk) => {
      const bar = el('div', 'skill-bar', el('i'));
      (bar.firstChild as HTMLElement).style.width = `${Math.max(2, (sk.dps / top) * 100)}%`;
      const label = el('span', 'skill-name', sk.name, sk.part && el('small', '', sk.part));
      return el('li', `skill${sk.main ? ' main' : ''}`, label, el('span', 'skill-dps', compact(sk.dps)), bar);
    }),
  );
  $('dps-note').textContent = 'DPS per skill';
}

function dl(target: HTMLElement, rows: ([string, string, string?] | 'sep')[]) {
  target.replaceChildren(
    ...rows.flatMap((r) => (r === 'sep' ? [el('div', 'sep')] : [el('dt', '', r[0]), el('dd', r[2] ?? '', r[1])])),
  );
}

function renderDefences(s: Stats) {
  const rows: ([string, string, string?] | 'sep')[] = [
    ['Evasion', fmt(n(s, 'Evasion'))],
    ['Armour', fmt(n(s, 'Armour'))],
  ];
  if (n(s, 'DeflectionRating') > 0) rows.push(['Deflect chance', `${fmt(n(s, 'DeflectChance'))}%`]);
  rows.push(['Movement speed', `${n(s, 'EffectiveMovementSpeedMod') >= 0 ? '+' : ''}${fmt(n(s, 'EffectiveMovementSpeedMod'))}%`]);
  rows.push('sep');
  for (const t of ['Physical', 'Fire', 'Cold', 'Lightning', 'Chaos']) rows.push([`Max ${t.toLowerCase()} hit`, fmt(n(s, `${t}MaximumHitTaken`))]);
  dl($('defences'), rows);
}

function renderAttributes(s: Stats) {
  dl(
    $('attributes'),
    (
      [
        ['Strength', 'Str'],
        ['Dexterity', 'Dex'],
        ['Intelligence', 'Int'],
      ] as const
    ).map(([label, k]) => {
      const have = n(s, k);
      const req = n(s, `Req${k}`);
      return [label, req > have ? `${fmt(have)} / ${fmt(req)} needed` : fmt(have), req > have ? 'bad' : ''];
    }),
  );
}

function renderFreshness(v: BuildView) {
  const b = v.build;
  const box = $('freshness');
  if (!b) return box.replaceChildren();
  const parts: string[] = [];
  let stale: boolean;
  if (b.source.kind === 'ninja') {
    stale = isStale(b.snapshotAt ?? b.importedAt);
    parts.push(b.snapshotAt ? `poe.ninja checked ${ageText(b.snapshotAt)}` : 'from poe.ninja');
    parts.push(`loaded ${ageText(b.importedAt)}`);
  } else {
    stale = isStale(b.importedAt);
    parts.push(`Build code pasted ${ageText(b.importedAt)}`);
  }
  box.textContent = parts.join(' · ') + (stale ? ' · consider refreshing' : '');
  box.classList.toggle('stale', stale);
  $('hero-refresh').hidden = !v.settings.ninja;
}

function render(v: BuildView) {
  current = v;
  const engine = $('engine-state');
  engine.className = `engine-state ${v.engine}`;
  engine.querySelector('span')!.textContent =
    v.engine === 'ready' ? 'Path of Building ready' : v.engine === 'failed' ? 'Path of Building failed to start' : 'Starting Path of Building…';
  if (v.engineError) message(v.engineError, 'error');

  const ov = v.overview;
  $('empty').hidden = !!v.build || v.engine === 'starting';
  $('char').hidden = !ov;

  if (ov) {
    const cls = ov.ascendancy && ov.ascendancy !== 'None' ? ov.ascendancy : ov.className ?? '';
    $('hero-title').replaceChildren(el('span', 'lvl', `Level ${ov.level ?? '?'}`), ` ${cls}`);
    $('hero-sub').textContent = [
      ov.mainSkill && `Main skill: ${ov.mainSkill}`,
      ov.weaponSet === 2 && 'uses weapon set 2',
      v.build?.source.kind === 'ninja' && v.build.source.character,
    ]
      .filter(Boolean)
      .join(' · ');
    renderFreshness(v);
    renderKpis(ov);
    renderResistances(ov.stats);
    renderSkills(ov);
    renderDefences(ov.stats);
    renderAttributes(ov.stats);
    $('gear').replaceChildren(...ov.gear.map((g) => itemCard(g.slot, g.item)));
    $('jewels-card').hidden = ov.jewels.length === 0;
    $('jewel-count').textContent = `${ov.jewels.length}`;
    $('jewels').replaceChildren(...ov.jewels.map((j) => itemCard('Jewel', j.item)));
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

const paste = (btn: HTMLButtonElement) => run(btn, () => api.pasteBuild(), 'Build code loaded.');
for (const id of ['empty-paste', 'hero-paste', 'source-paste']) {
  const b = $<HTMLButtonElement>(id);
  b.addEventListener('click', () => void paste(b).then(() => current?.overview && showPage('character')));
}

const refresh = (btn: HTMLButtonElement) => run(btn, () => api.refreshNinja(), 'Loaded the latest state from poe.ninja.');
$<HTMLButtonElement>('hero-refresh').addEventListener('click', (e) => void refresh(e.currentTarget as HTMLButtonElement));
$<HTMLButtonElement>('ninja-refresh').addEventListener('click', (e) => void refresh(e.currentTarget as HTMLButtonElement));

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
setInterval(() => current && renderFreshness(current), 60_000);
