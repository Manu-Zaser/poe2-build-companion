// Invisible test of the target build (phase 3): start only via scripts/run-hidden.cjs.
//   npx electron scripts/run-hidden.cjs scripts/target-ui.cjs <output folder>
// Optional: TARGET_UI_BUILD=<code file> (own build) and TARGET_UI_TARGET=<code file> (target build);
// both default to the fixture build. Hidden windows, own profile, no hotkey, no keys sent.
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
  // Never the real Path of Building folder.
  const builds = path.join(out, 'builds');
  fs.mkdirSync(builds, { recursive: true });
  process.env.COMPANION_POB_BUILDS = builds;

  const fixtureCode = path.join(root, 'test/fixtures/deadeye.code');
  const buildCode = fs.readFileSync(process.env.TARGET_UI_BUILD ?? fixtureCode, 'utf8');
  const targetCode = fs.readFileSync(process.env.TARGET_UI_TARGET ?? fixtureCode, 'utf8');
  let clip = buildCode;
  clipboard.readText = async () => clip;
  const fixture = (n) => fs.readFileSync(path.join(fixtures, n), 'utf8');

  const log = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const flat = (s) => s.replace(/\n+/g, ' | ');
  const snap = async (wc, name) => {
    wc.invalidate();
    await wait(500);
    fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG());
  };
  const until = async (wc, expr, ms = 20_000) => {
    for (let t = 0; t < ms; t += 200) {
      if (await wc.executeJavaScript(expr)) return true;
      await wait(200);
    }
    throw new Error(`timeout waiting for ${expr}`);
  };

  let mainWc = null;
  let overlayWc = null;
  app.on('browser-window-created', (_e, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (e) => log.push(`console: ${e.message}`));
    win.webContents.once('did-finish-load', () => {
      const url = win.webContents.getURL();
      if (url.endsWith('overlay.html')) overlayWc = win.webContents;
      else if (url.endsWith('app.html')) {
        win.setSize(1360, 1000);
        mainWc = win.webContents;
      }
      if (mainWc && overlayWc) void run();
    });
  });

  async function check(text, name) {
    await overlayWc.executeJavaScript(`document.getElementById('root').replaceChildren()`);
    await globalThis.__companionTest.itemCheck(text);
    await until(overlayWc, `!!document.querySelector('#root .card')`);
    log.push(`${name}: ${flat(await overlayWc.executeJavaScript(`[...document.querySelectorAll('.fit')].map((f) => f.innerText).join(' || ') || '(no fit block)'`))}`);
    await snap(overlayWc, `${name}.png`);
  }

  async function run() {
    const js = (c) => mainWc.executeJavaScript(c);
    try {
      await mainWc.insertCSS('*, *::before { animation: none !important; transition: none !important; }');
      await until(mainWc, `document.getElementById('engine-state').classList.contains('ready')`);
      await js(`document.getElementById('empty-paste').click()`);
      await until(mainWc, `!document.getElementById('char').hidden`);

      await check(fixture('rare-gloves-advanced.txt'), '1-no-target');

      await js(`document.querySelector('.nav-item[data-page=target]').click()`);
      clip = targetCode;
      await js(`document.getElementById('target-paste').click()`);
      await until(mainWc, `!document.getElementById('target-current').hidden`);
      log.push(`target: ${await js(`document.getElementById('target-name').innerText`)} | ${await js(`document.getElementById('target-meta').innerText`)}`);
      log.push(`progress: ${await js(`document.getElementById('target-progress-note').innerText`)}`);
      log.push(`rows: ${await js(`[...document.querySelectorAll('.target-row')].map((r) => r.querySelector('.slot').innerText + ' ' + r.querySelector('.score').innerText).join(', ')`)}`);
      // Hidden windows repaint lazily: give it time and take the picture twice.
      await wait(1500);
      await snap(mainWc, '2-target-page.png');
      await snap(mainWc, '2-target-page.png');

      await check(fixture('rare-gloves-advanced.txt'), '3-gloves');
      await check(fixture('rare-ring.txt'), '4-ring');
      await check(fixture('rare-body-armour-hybrid.txt'), '5-body');

      const stored = JSON.parse(fs.readFileSync(path.join(profile, 'companion.json'), 'utf8'));
      log.push(`stored target: ${stored.target.name} (${stored.target.source}, ${stored.target.code.length} chars)`);

      await js(`document.getElementById('target-clear').click()`);
      await until(mainWc, `document.getElementById('target-current').hidden`);
      await check(fixture('rare-gloves-advanced.txt'), '6-target-removed');
    } catch (err) {
      log.push('error: ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n'));
    app.exit(0);
  }

  require(path.join(root, 'dist/main.js'));
};
