// Invisible test of the item check (phase 2): start only via scripts/run-hidden.cjs.
//   npx electron scripts/run-hidden.cjs scripts/check-ui.cjs <output folder>
// Windows stay hidden, a separate profile is used, no global hotkey is registered and no keys are
// sent: the item check is called directly with fixture item texts.
const { app, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

module.exports = (out) => {
  process.env.COMPANION_TEST = '1';
  const root = path.join(__dirname, '..');
  const fixtures = path.join(root, '..', 'price-check', 'test', 'fixtures');
  const profile = path.join(out, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);

  const code = fs.readFileSync(path.join(root, 'test/fixtures/deadeye.code'), 'utf8');
  clipboard.readText = async () => code;
  const fixture = (n) => fs.readFileSync(path.join(fixtures, n), 'utf8');

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
  const flat = (s) => s.replace(/\n+/g, ' | ');

  let mainWc = null;
  let overlayWc = null;
  app.on('browser-window-created', (_e, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (e) => log.push(`console: ${e.message}`));
    win.webContents.once('did-finish-load', () => {
      const url = win.webContents.getURL();
      if (url.endsWith('overlay.html')) overlayWc = win.webContents;
      else if (url.endsWith('app.html')) {
        win.setSize(1360, 960);
        mainWc = win.webContents;
      }
      if (mainWc && overlayWc) void run();
    });
  });

  /** Runs an item check and returns the overlay text once it has rendered. */
  async function check(text, name) {
    await overlayWc.executeJavaScript(`document.getElementById('root').replaceChildren()`);
    const t0 = Date.now();
    await globalThis.__companionTest.itemCheck(text);
    await until(overlayWc, `!!document.querySelector('#root .card')`);
    log.push(`${name}: overlay after ${Date.now() - t0} ms`);
    log.push(`  ${flat(await overlayWc.executeJavaScript(`document.getElementById('root').innerText`))}`);
    await snap(overlayWc, `${name}.png`);
  }

  async function run() {
    try {
      await until(mainWc, `document.getElementById('engine-state').classList.contains('ready')`);
      // Item check before a build is loaded: clear message.
      await check(fixture('rare-gloves-advanced.txt'), '0-no-build');

      await mainWc.executeJavaScript(`document.getElementById('empty-paste').click()`);
      await until(mainWc, `!document.getElementById('char').hidden`);

      await check(fixture('rare-gloves-advanced.txt'), '1-gloves');
      await check(fixture('rare-ring.txt'), '2-ring');
      await check(fixture('rare-body-armour-hybrid.txt'), '3-body');
      await check('Hello, not an item', '4-not-an-item');
      await check(fixture('currency-divine.txt'), '5-currency');

      // Equip in my build (from the overlay button).
      await check(fixture('rare-gloves-advanced.txt'), '6-gloves-again');
      await overlayWc.executeJavaScript(`document.querySelector('.btn.primary').click()`);
      await until(overlayWc, `!!document.querySelector('.done')`);
      log.push(`after equip overlay: ${flat(await overlayWc.executeJavaScript(`document.querySelector('.slot-line').innerText`))}`);
      await until(mainWc, `!document.getElementById('local-changes').hidden`);
      log.push(`header: ${flat(await mainWc.executeJavaScript(`document.getElementById('local-changes').innerText`))}`);
      log.push(`gloves now: ${await mainWc.executeJavaScript(`[...document.querySelectorAll('#doll .cell')].map((c) => c.innerText).join(' / ')`)}`);
      const stored = JSON.parse(fs.readFileSync(path.join(profile, 'companion.json'), 'utf8'));
      log.push(`stored equips: ${JSON.stringify(stored.build.equips.map((e) => [e.slot, e.name]))}`);
      await snap(mainWc, '7-main-after-equip.png');

      // The same gloves again: now "about the same".
      await check(fixture('rare-gloves-advanced.txt'), '8-gloves-equipped');

      // Reset local changes.
      await mainWc.executeJavaScript(`document.getElementById('reset-equips').click()`);
      await until(mainWc, `document.getElementById('local-changes').hidden`);
      log.push(`after reset: ${await mainWc.executeJavaScript(`[...document.querySelectorAll('#doll .cell')].map((c) => c.innerText).join(' / ')`)}`);

      // Item check page.
      await mainWc.executeJavaScript(`document.querySelector('.nav-item[data-page=check]').click()`);
      await wait(300);
      log.push(`check page height: ${await mainWc.executeJavaScript(`document.querySelector('.page[data-page=check]').offsetHeight + ' / active nav: ' + document.querySelector('.nav-item.active').innerText`)}`);
      log.push(`hotkey page:${flat(await mainWc.executeJavaScript(`document.getElementById('hk-keys').innerText + ' ' + document.getElementById('hk-state').innerText`))}`);
      await snap(mainWc, '9-check-page.png');
    } catch (err) {
      log.push('error: ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n'));
    app.exit(0);
  }

  require(path.join(root, 'dist/main.js'));
};
