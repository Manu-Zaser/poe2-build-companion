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
  const flat = (s) => s.replace(/\n+/g, ' · ');
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
  const js = (wc, code) => wc.executeJavaScript(code);
  const text = (wc, id) => js(wc, `document.getElementById(${JSON.stringify(id)}).innerText`);

  app.on('browser-window-created', (_e, win) => {
    win.setSize(1360, 960);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    wc.on('console-message', (e) => log.push(`console: ${e.message}`));
    wc.once('did-finish-load', async () => {
      try {
        await wc.insertCSS('*, *::before { animation: none !important; transition: none !important; }');
        await until(wc, `document.getElementById('engine-state').classList.contains('ready')`);
        await snap(wc, '1-empty.png');

        const t0 = Date.now();
        await js(wc, `document.getElementById('empty-paste').click()`);
        await until(wc, `!document.getElementById('char').hidden`);
        log.push(`paste → overview in ${Date.now() - t0} ms`);
        log.push(`header: ${await text(wc, 'p-name')} | ${await text(wc, 'p-class')} | ${flat(await text(wc, 'p-meta'))}`);
        log.push(`character: ${flat(await text(wc, 'st-character'))}`);
        log.push(`defensive: ${flat(await text(wc, 'st-defensive'))}`);
        log.push(`recovery: ${flat(await text(wc, 'st-recovery'))}`);
        log.push(`main skills: ${flat(await text(wc, 'st-skills'))}`);
        log.push(`gem groups: ${await js(wc, `document.querySelectorAll('.gem-group').length`)}`);
        log.push(`doll cells filled: ${await js(wc, `document.querySelectorAll('#doll .cell.filled').length`)}`);
        log.push(`msg: ${await text(wc, 'msg')}`);
        await snap(wc, '2-character.png');

        // Weapon set toggle switches the shown weapons.
        const before = await js(wc, `document.querySelector('#doll .cell').innerText`);
        await js(wc, `document.querySelector('#set-toggle button[data-set="1"]').click()`);
        const after = await js(wc, `document.querySelector('#doll .cell').innerText`);
        log.push(`weapon set toggle: "${before}" → "${after}"`);

        const stored = JSON.parse(fs.readFileSync(path.join(profile, 'companion.json'), 'utf8'));
        log.push(`stored: source=${stored.build.source.kind} code=${stored.build.code.length} chars`);

        await js(wc, `document.querySelector('[data-page=source]').click()`);
        await js(wc, `document.getElementById('ninja-link').value = 'https://example.com'; document.getElementById('ninja-save').click()`);
        await until(wc, `!document.getElementById('msg').hidden && document.getElementById('msg').classList.contains('error')`);
        log.push(`invalid link msg: ${await text(wc, 'msg')}`);

        const link = process.env.UI_CHECK_NINJA;
        if (link) {
          await js(wc, `document.getElementById('ninja-link').value = ${JSON.stringify(link)}; document.getElementById('ninja-save').click()`);
          await until(wc, `!document.getElementById('ninja-save').disabled && !document.getElementById('msg').innerText.includes('example')`, 30_000);
          log.push(`ninja msg: ${await text(wc, 'msg')}`);
          await js(wc, `document.querySelector('.nav-item[data-page=character]').click()`);
          await wait(300);
          log.push(`header after ninja: ${await text(wc, 'p-name')} | ${flat(await text(wc, 'p-meta'))}`);
          await until(wc, `[...document.querySelectorAll('#doll img')].every((i) => i.complete)`, 15_000);
          const pics = await js(wc, `[...document.querySelectorAll('#doll img, #belt-items img, #jewels img')].map((i) => i.naturalWidth > 0)`);
          log.push(`pictures loaded: ${pics.filter(Boolean).length} of ${pics.length}`);
          log.push(`main skills: ${flat(await text(wc, 'st-skills'))}`);
          log.push(`defensive: ${flat(await text(wc, 'st-defensive'))}`);
          await snap(wc, '5-character-ninja.png');
          await js(wc, `document.querySelector('#doll .cell.filled').dispatchEvent(new MouseEvent('mouseenter'))`);
          await snap(wc, '6-tooltip.png');
          await js(wc, `document.querySelector('#doll .cell.filled').dispatchEvent(new MouseEvent('mouseleave')); document.querySelector('main').scrollTo(0, 99999)`);
          await snap(wc, '7-bottom.png');
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
