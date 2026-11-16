// Invisible test of the Upgrades page with a LIVE trade search (2 slots: about 4 searches and 6 fetches).
// Start only via scripts/run-hidden.cjs:
//   npx electron scripts/run-hidden.cjs scripts/upgrades-ui.cjs <output folder>
// The window stays hidden, a separate profile is used and the clipboard is replaced by a fixture.
const { app, clipboard } = require('electron');
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

  const slots = (process.env.UP_SLOTS ?? 'Amulet,Boots').split(',');
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
