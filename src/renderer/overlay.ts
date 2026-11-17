import type { Api } from '../main/preload';
import type { OverlayContent } from '../shared/types';
import { fitCount, type Fit } from '../shared/targets';
import { VERDICT_TEXT, type SlotVerdict } from '../shared/verdict';
import { compact, fmt } from './format';

declare global {
  interface Window { api: Api }
}
const api = window.api;
const root = document.getElementById('root')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

const SLOT_NAMES: Record<string, string> = {
  'Weapon 1': 'main hand',
  'Weapon 2': 'off hand',
  'Weapon 1 Swap': 'main hand (set II)',
  'Weapon 2 Swap': 'off hand (set II)',
  'Ring 1': 'left ring',
  'Ring 2': 'right ring',
  'Body Armour': 'body armour',
};
const slotName = (s: string) => SLOT_NAMES[s] ?? s.toLowerCase();

const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '±');
const cls = (n: number, eps = 0) => (n > eps ? 'up' : n < -eps ? 'down' : 'flat');
const pctText = (p: number) => `${sign(p)}${fmt(Math.abs(Math.round(p * 10) / 10))}%`;

/** "+8 % DPS · +210 EHP" – the short line under the verdict. */
function summary(v: SlotVerdict): string {
  const parts: string[] = [];
  if (Math.abs(v.dpsPct) >= 0.1) parts.push(`${pctText(v.dpsPct)} DPS`);
  if (Math.abs(Math.round(v.ehpDelta)) >= 1) parts.push(`${sign(v.ehpDelta)}${compact(Math.abs(Math.round(v.ehpDelta)))} EHP`);
  return parts.join(' · ') || 'No change to damage or effective health';
}

function closeButton() {
  const b = el('button', 'close', '×');
  b.title = 'Close (Esc)';
  b.addEventListener('click', () => api.hideOverlay());
  return b;
}

function equipButton(v: SlotVerdict, content: Extract<OverlayContent, { kind: 'check' }>, primary: boolean): HTMLElement {
  if (content.equipped === v.slot) return el('span', 'done', '✓ Equipped in your build');
  const b = el('button', `btn${primary ? ' primary' : ''}`, 'Equip in my build');
  b.title = `Put this item into your ${slotName(v.slot)} in the local copy of your build`;
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = 'Equipping…';
    const res = await api.equip(v.slot);
    if (!res.ok) {
      b.disabled = false;
      b.textContent = 'Equip in my build';
      b.title = res.error ?? 'Could not equip';
    }
  });
  return b;
}

/** "Fits your build: 3 of 4 target stats" with the checklist (full only for the best slot). */
function fitBlock(fit: Fit, full: boolean): HTMLElement {
  const { have, total } = fitCount(fit);
  const box = el('div', 'fit');
  let head: string;
  if (fit.unique) head = have ? `Fits your build: this is the ${fit.targetName} from your target` : `Your target has ${fit.targetName} here`;
  else head = total ? `Fits your build: ${have} of ${total} target stats` : 'Fits your build: no key stats to compare';
  const cls = fit.unique ? (have ? 'good' : 'off') : total && have / total >= 0.67 ? 'good' : have / Math.max(1, total) >= 0.34 ? 'some' : 'off';
  box.classList.add(cls);
  box.append(el('div', 'fit-head', head));
  if (!full || fit.unique) {
    const missing = fit.missing.filter((w) => !w.minor);
    if (!fit.unique && missing.length) box.append(el('div', 'fit-missing', `missing: ${missing.map((w) => w.label).join(', ')}`));
    return box;
  }
  const list = el('ul', 'fit-list');
  for (const w of fit.have) {
    const vals = w.itemValue !== undefined && w.value !== undefined ? ` (${fmt(w.itemValue)} · target ${fmt(w.value)})` : '';
    list.append(el('li', `has${w.minor ? ' minor' : ''}`, `✓ ${w.label}`, el('small', '', vals)));
  }
  for (const w of fit.missing) list.append(el('li', `miss${w.minor ? ' minor' : ''}`, `✗ ${w.label}`));
  box.append(list);
  return box;
}

const UPGRADE_SLOT_NAMES = new Set(['Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Belt']);

/** "Find better for this slot": PoB's weighted search in the browser, set up like the Upgrades page. */
function weightedButton(slot: string): HTMLElement | null {
  if (!UPGRADE_SLOT_NAMES.has(slot)) return null;
  const b = el('button', 'link-btn', `Find better ${slotName(slot).toLowerCase()} on the trade site ↗`);
  b.title = "Path of Building's weighted search for this slot, in your browser (sign in on the trade site there). Weighting and budget as on the Upgrades page.";
  b.addEventListener('click', async () => {
    let form: Record<string, unknown> = {};
    try {
      form = JSON.parse(localStorage.getItem('upgrades-form') ?? '{}') ?? {};
    } catch {
      // Standardwerte
    }
    b.disabled = true;
    b.textContent = 'Opening…';
    const res = await api.weightedSearch(slot, { dpsWeight: form.dpsWeight as number, instantOnly: form.instantOnly as boolean, budget: form.budget as number, currency: form.currency as string });
    b.disabled = false;
    b.textContent = res.ok ? 'Opened in your browser ✓' : `Find better ${slotName(slot).toLowerCase()} on the trade site ↗`;
    if (!res.ok) b.title = res.error ?? 'Could not open the search';
  });
  return b;
}

function slotBlock(v: SlotVerdict, content: Extract<OverlayContent, { kind: 'check' }>, first: boolean): HTMLElement {
  const block = el('div', 'slot-block');
  block.append(
    el('div', 'slot-line', el('span', '', 'Instead of ', el('b', '', v.replaces ?? 'nothing'), ` (${slotName(v.slot)})`), equipButton(v, content, first)),
  );
  block.append(el('div', `verdict ${v.kind}`, el('div', 'v', VERDICT_TEXT[v.kind]), el('div', 'sub', summary(v))));
  if (v.warnings.length) block.append(el('ul', 'warns', ...v.warnings.map((w) => el('li', '', w))));
  const fit = content.fits?.[v.slot];
  if (fit) block.append(fitBlock(fit, first));
  if (!first) return block;

  block.append(
    el(
      'div',
      'kpis',
      el('div', 'kpi', el('span', '', `DPS · ${content.mainSkill ?? 'main skill'}`), el('strong', cls(v.dpsPct, 0.05), pctText(v.dpsPct))),
      el('div', 'kpi', el('span', '', 'Effective HP'), el('strong', cls(v.ehpDelta, 0.5), `${sign(v.ehpDelta)}${compact(Math.abs(Math.round(v.ehpDelta)))}`)),
    ),
  );
  if (v.changes.length) {
    block.append(
      el(
        'dl',
        'changes',
        ...v.changes.flatMap((c) => [el('dt', '', c.label), el('dd', c.good ? 'up' : 'down', `${sign(c.delta)}${fmt(Math.abs(c.delta))}${c.unit ?? ''}`)]),
      ),
    );
  }
  const weighted = weightedButton(v.slot);
  if (weighted) block.append(el('div', 'weighted-line', weighted));
  return block;
}

function render(c: OverlayContent): HTMLElement {
  if (c.kind === 'error') {
    return el('div', 'card card-error', el('div', 'head', el('div', 'title', el('div', 'n', 'Item check')), closeButton()), el('div', 'msg', c.message));
  }
  const rarity = `rarity-${c.item.rarity.toLowerCase()}`;
  const hasTitle = !!c.item.title && c.item.title !== c.item.base;
  const card = el(
    'div',
    'card',
    el('div', 'head', el('div', 'title', el('div', `n ${rarity}`, hasTitle ? c.item.title! : c.item.base), hasTitle && el('div', 'b', c.item.base)), closeButton()),
  );
  const body = el('div', '');
  c.verdicts.forEach((v, i) => body.append(slotBlock(v, c, i === 0)));
  card.append(body);
  const open = el('a', '', 'Open character');
  open.addEventListener('click', () => api.openApp());
  card.append(el('div', 'foot', el('span', '', `Path of Building · ${c.ms} ms`), open));
  return card;
}

/** Reports the natural size of the content so the window can be fitted to it. */
function reportSize() {
  const card = root.firstElementChild as HTMLElement | null;
  const rect = root.getBoundingClientRect();
  const height = card ? Math.max(rect.height, card.scrollHeight + (card.offsetHeight - card.clientHeight)) : rect.height;
  api.overlayReady({ width: rect.width, height });
}

api.onOverlayContent((c) => {
  try {
    root.replaceChildren(render(c));
  } catch (e) {
    // Better an error card than an empty, invisible window above the game.
    root.replaceChildren(render({ kind: 'error', message: `Display error: ${e instanceof Error ? e.message : String(e)}` }));
  }
  reportSize();
});

// ---------- Drag from anywhere (except buttons and links); the window follows the real cursor ----------

const DRAG_THRESHOLD = 4;
let press: { x: number; y: number; dragging: boolean } | null = null;
let suppressClick = false;

function endPress() {
  if (press?.dragging) api.dragEnd();
  press = null;
  document.body.classList.remove('dragging');
}

root.addEventListener('pointerdown', (e) => {
  suppressClick = false;
  press = null;
  if (e.button !== 0 || (e.target as HTMLElement).closest('button, a')) return;
  press = { x: e.screenX, y: e.screenY, dragging: false };
});
window.addEventListener('pointermove', (e) => {
  if (!press) return;
  if (press.dragging) {
    api.dragMove();
    return;
  }
  // Released outside the window: drop the old press.
  if ((e.buttons & 1) === 0) {
    press = null;
    return;
  }
  if (Math.hypot(e.screenX - press.x, e.screenY - press.y) >= DRAG_THRESHOLD) {
    press.dragging = true;
    suppressClick = true;
    document.body.classList.add('dragging');
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      // without capture, dragging ends at the latest with the next click
    }
    api.dragStart();
  }
});
window.addEventListener('pointerup', () => {
  endPress();
  setTimeout(() => (suppressClick = false), 0);
});
window.addEventListener('pointercancel', endPress);
root.addEventListener('lostpointercapture', endPress);
window.addEventListener('blur', endPress);
root.addEventListener(
  'click',
  (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

// Mouse leaves the overlay → keyboard back to the game (if a click made the overlay active).
let hovering = false;
window.addEventListener('pointermove', () => (hovering = true));
document.documentElement.addEventListener('pointerleave', () => {
  if (!hovering || press?.dragging) return;
  hovering = false;
  api.overlayLeave();
});
// A click into the overlay makes it active so buttons always react over a fullscreen game.
root.addEventListener('pointerdown', () => api.focusOverlay());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.hideOverlay();
});
