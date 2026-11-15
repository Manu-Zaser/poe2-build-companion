// Invisible UI test: start only via scripts/run-hidden.cjs.
//   npx electron scripts/run-hidden.cjs scripts/ui-check.cjs <output folder>
// The window stays hidden, a separate profile is used and the clipboard is replaced by a fixture.
// Optional: UI_CHECK_NINJA=<poe.ninja character link> also tests the poe.ninja connection (network).
const { app, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

module.exports = (out) => {
  const root = path.join(__dirname, '..');
  const profile = path.join(out, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);

  const code = fs.readFileSync(path.join(root, 'test/fixtures/deadeye.code'), 'utf8');
  clipboard.readText = async () => code;

  const log = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = async (wc, name) => {
    wc.invalidate();
    await wait(400);
    fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG());
  };
  const until = async (wc, expr, ms = 20_000) => {
    for (let t = 0; t < ms; t += 200) {
      if (await wc.executeJavaScript(expr)) return true;
      await wait(200);
    }
    throw new Error(`timeout waiting for ${expr}`);
  };
  const text = (wc, id) => wc.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).innerText`);

  app.on('browser-window-created', (_e, win) => {
    win.setSize(1320, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    wc.on('console-message', (e) => log.push(`console: ${e.message}`));
    wc.once('did-finish-load', async () => {
      try {
        await wc.insertCSS('*, *::before { animation: none !important; transition: none !important; }');
        await until(wc, `document.getElementById('engine-state').classList.contains('ready')`);
        await snap(wc, '1-empty.png');

        const t0 = Date.now();
        await wc.executeJavaScript(`document.getElementById('empty-paste').click()`);
        await until(wc, `!document.getElementById('char').hidden`);
        log.push(`paste → overview in ${Date.now() - t0} ms`);
        log.push('hero: ' + (await text(wc, 'hero-title')) + ' | ' + (await text(wc, 'hero-sub')));
        log.push('freshness: ' + (await text(wc, 'freshness')));
        log.push('kpis: ' + (await text(wc, 'kpis')).replace(/\n+/g, ' · '));
        log.push('resistances: ' + (await text(wc, 'res-list')).replace(/\n+/g, ' '));
        log.push('skills: ' + (await text(wc, 'skills')).replace(/\n+/g, ' '));
        log.push('msg: ' + (await text(wc, 'msg')));
        await snap(wc, '2-character.png');
        await wc.executeJavaScript(`document.querySelector('main').scrollTo(0, 99999)`);
        await snap(wc, '3-character-bottom.png');

        // Saved state survives: the stored build must be in the profile.
        const stored = JSON.parse(fs.readFileSync(path.join(profile, 'companion.json'), 'utf8'));
        log.push(`stored: source=${stored.build.source.kind} code=${stored.build.code.length} chars`);

        await wc.executeJavaScript(`document.querySelector('[data-page=source]').click()`);
        // Invalid link must give a clear message.
        await wc.executeJavaScript(`document.getElementById('ninja-link').value = 'https://example.com'; document.getElementById('ninja-save').click()`);
        await until(wc, `!document.getElementById('msg').hidden && document.getElementById('msg').classList.contains('error')`);
        log.push('invalid link msg: ' + (await text(wc, 'msg')));

        const link = process.env.UI_CHECK_NINJA;
        if (link) {
          await wc.executeJavaScript(`document.getElementById('ninja-link').value = ${JSON.stringify(link)}; document.getElementById('ninja-save').click()`);
          await until(wc, `!document.getElementById('ninja-save').disabled && !document.getElementById('msg').hidden && !document.getElementById('msg').innerText.includes('example')`, 30_000);
          log.push('ninja msg: ' + (await text(wc, 'msg')));
          log.push('ninja current: ' + (await text(wc, 'ninja-current')).replace(/\n+/g, ' | '));
          await snap(wc, '4-source.png');
          await wc.executeJavaScript(`document.querySelector('[data-page=character]').click()`);
          log.push('freshness after ninja: ' + (await text(wc, 'freshness')));
          await snap(wc, '5-character-ninja.png');
        } else {
          await snap(wc, '4-source.png');
        }
      } catch (err) {
        log.push('error: ' + err.stack);
      }
      fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n'));
      app.exit(0);
    });
  });
  require(path.join(root, 'dist/main.js'));
};
