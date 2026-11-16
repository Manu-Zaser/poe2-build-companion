// Invisible test of the Upgrades page. Start only via scripts/run-hidden.cjs:
//   npx electron scripts/run-hidden.cjs scripts/upgrades-ui.cjs <output folder>
// By default OFFLINE: the search is answered with made-up results (no request to the trade site).
// UP_LIVE=1 runs a LIVE trade search instead (2 slots: about 4 searches and 6 fetches – mind the rate limit).
// The window stays hidden, a separate profile is used and the clipboard is replaced by a fixture.
const { app, clipboard, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

module.exports = (out) => {
  process.env.COMPANION_TEST = '1';
  const root = path.join(__dirname, '..');
  const profile = path.join(out, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  const code = fs.readFileSync(path.join(root, 'test/fixtures/deadeye.code'), 'utf8');
  clipboard.readText = async () => code;

  const slots = (process.env.UP_SLOTS ?? (process.env.UP_LIVE === '1' ? 'Amulet,Boots' : 'Helmet,Boots,Ring 2')).split(',');
  const log = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (wc, c) => wc.executeJavaScript(c);
  const until = async (wc, expr, ms = 20_000) => {
    for (let t = 0; t < ms; t += 250) {
      if (await js(wc, expr)) return;
      await wait(250);
    }
    throw new Error(`timeout waiting for ${expr}`);
  };
  const snap = async (wc, name) => {
    wc.invalidate();
    await wait(400);
    fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG());
  };

  // Offline: replace the search with made-up results once the app has registered its handlers.
  const fakeRun = (slotsAsked) => {
    const item = (title, base, rarity, mods) => ({ name: `${title}, ${base}`, title, base, rarity, corrupted: false, mods: mods.map((text) => ({ text, kind: 'explicit' })), raw: '' });
    const cand = (title, base, price, dps, ehp, extra = {}) => ({
      item: item(title, base, 'RARE', ['+92 to maximum Life', '+38% to Cold Resistance', '+30% to Lightning Resistance']),
      price,
      priceDivine: price.currency === 'divine' ? price.amount : price.amount / 544,
      dpsPct: dps,
      ehpPct: ehp,
      gain: (dps + ehp) / 2,
      upgrade: (dps + ehp) / 2 >= 1 && !(extra.blocking || []).length,
      blocking: [],
      warnings: [],
      changes: [],
      listedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      tradeUrl: 'https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites?q=%7B%7D',
      icon: base.endsWith('Sandals')
        ? 'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQXJtb3Vycy9Cb290cy9CYXNldHlwZXMvQm9vdHNJbnQwNiIsInciOjIsImgiOjIsInNjYWxlIjoxLCJyZWFsbSI6InBvZTIifV0/0fe23f857a/BootsInt06.png'
        : 'https://web.poecdn.com/gen/image/WzI1LDE0LHsiZiI6IjJESXRlbXMvQW11bGV0cy9CYXNldHlwZXMvR29sZEFtdWxldCIsInciOjEsImgiOjEsInNjYWxlIjoxLCJyZWFsbSI6InBvZTIifV0/7da5b5dc6e/GoldAmulet.png',
      ...extra,
    });
    const results = [
      {
        slot: 'Helmet', current: 'Kraken Ward', total: 82, evaluated: 25, overBudget: 5,
        searched: ['Enemies you Mark take x% increased Damage', 'Fire resistance', 'Cold resistance', 'x% increased Energy Shield', 'x% increased Critical Hit Chance'],
        tradeUrl: 'https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/abc',
        candidates: [
          cand('Loath Visage', 'Sorcerous Tiara', { amount: 9, currency: 'divine' }, 0, 13.4, { warnings: ['Cold resistance drops further below the cap (58% of 81%)'] }),
          cand('Entropy Glance', 'Grinning Mask', { amount: 120, currency: 'exalted' }, -2.3, 9.2),
          cand('Sorrow Crown', 'Sandsworn Tiara', { amount: 10, currency: 'divine' }, 0, -5.5),
          cand('Dread Dome', 'Grinning Mask', { amount: 9, currency: 'divine' }, 0, -8.6, { blocking: ['Fire resistance falls below the cap (70% of 75%)'], upgrade: false }),
        ],
      },
      {
        slot: 'Boots', current: 'Vengeance Trail', total: 350, evaluated: 30,
        tradeUrl: 'https://www.pathofexile.com/trade2/search/poe2/Forbidden%20Rites/def',
        candidates: [
          cand('Victory Spur', 'Sekhema Sandals', { amount: 5, currency: 'chaos' }, 0, -0.4),
          cand('Behemoth League', 'Sekhema Sandals', { amount: 3, currency: 'chaos' }, 0, -0.6),
        ],
      },
      { slot: 'Ring 2', current: 'Armageddon Hold', total: 0, evaluated: 0, candidates: [] },
    ].filter((r) => slotsAsked.includes(r.slot));
    return { running: false, league: 'Forbidden Rites', exaltedPerDivine: 544, budgetExalted: 5440, results };
  };
  if (process.env.UP_LIVE !== '1') {
    app.on('browser-window-created', (_e, win) => {
      win.webContents.once('did-finish-load', () => {
        ipcMain.removeHandler('upgrades:start');
        ipcMain.handle('upgrades:start', async (e, req) => {
          const steps = ['weights', 'search', 'fetch', 'evaluate'];
          for (const [i, slot] of req.slots.entries()) {
            for (const step of steps) {
              e.sender.send('upgrades:changed', { running: true, league: 'Forbidden Rites', results: [], progress: { slot, index: i, count: req.slots.length, step } });
              await wait(120);
            }
          }
          const run = fakeRun(req.slots);
          e.sender.send('upgrades:changed', run);
          return run;
        });
      });
    });
  }

  app.on('browser-window-created', (_e, win) => {
    const wc = win.webContents;
    wc.once('did-finish-load', async () => {
      if (!wc.getURL().endsWith('app.html')) return;
      win.setSize(1360, 1100);
      wc.setBackgroundThrottling(false);
      wc.on('console-message', (e) => log.push(`console: ${e.message}`));
      try {
        await wc.insertCSS('*, *::before { animation: none !important; transition: none !important; }');
        await until(wc, `document.getElementById('engine-state').classList.contains('ready')`);
        await js(wc, `document.getElementById('empty-paste').click()`);
        await until(wc, `!document.getElementById('char').hidden`);
        await js(wc, `document.querySelector('.nav-item[data-page=upgrades]').click()`);
        log.push(`default slots: ${await js(wc, `[...document.querySelectorAll('.up-slot.on .s1')].map(e => e.textContent).join(', ')`)}`);
        // Nur die gewünschten Slots auswählen (jeder Klick zeichnet die Liste neu).
        for (let i = 0; i < 12; i++) {
          const clicked = await js(
            wc,
            `(() => { const want = ${JSON.stringify(slots)}; for (const b of document.querySelectorAll('.up-slot')) { const s = b.querySelector('.s1').textContent; if (want.includes(s) !== b.classList.contains('on')) { b.click(); return true; } } return false; })()`,
          );
          if (!clicked) break;
        }
        log.push(`chosen: ${await js(wc, `[...document.querySelectorAll('.up-slot.on .s1')].map(e => e.textContent).join(', ')`)} | ${await js(wc, `document.getElementById('up-note').textContent`)}`);
        await snap(wc, 'up-1-form.png');

        const t0 = Date.now();
        await js(wc, `document.getElementById('up-start').click()`);
        await until(wc, `!document.getElementById('up-cancel').hidden`, 5000);
        const seen = new Set();
        while (await js(wc, `!document.getElementById('up-cancel').hidden`)) {
          seen.add(await js(wc, `document.getElementById('up-progress').textContent`));
          if (Date.now() - t0 > 80_000) throw new Error('search took too long');
          await wait(300);
        }
        log.push(`search done in ${Date.now() - t0} ms`);
        log.push(`progress texts: ${[...seen].map((s) => s.replace(/\s+Forbidden.*/, '')).join(' | ')}`);
        log.push(`final: ${await js(wc, `document.getElementById('up-progress').textContent`)}`);
        log.push(`banner: ${await js(wc, `document.getElementById('msg').hidden ? '-' : document.getElementById('msg').textContent`)}`);
        log.push(`results:\n${await js(wc, `document.getElementById('up-results').innerText`)}`);
        log.push(`links: ${await js(wc, `[...document.querySelectorAll('#up-results a')].map(a => a.href).join(' ')`)}`);
        await wait(1500);
        await snap(wc, 'up-2-results.png');
      } catch (err) {
        log.push(`error: ${err.stack ?? err}`);
      }
      fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n') + '\n', { flag: 'a' });
      app.exit(0);
    });
  });

  require(path.join(root, 'dist/main.js'));
};
