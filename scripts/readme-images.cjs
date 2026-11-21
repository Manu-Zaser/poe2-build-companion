// Screenshots for the README (docs/images). Start only via scripts/run-hidden.cjs:
//   npx electron scripts/run-hidden.cjs scripts/readme-images.cjs <output folder>
// Uses the demo build from the tests (test/fixtures/deadeye.code) and a separate, empty profile – never the
// player's own data. Windows stay hidden, no hotkey is registered and no keys are sent anywhere.
const { app, clipboard, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

module.exports = (out) => {
  process.env.COMPANION_TEST = '1';
  const root = path.join(__dirname, '..');
  const profile = path.join(out, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  // Leerer Ordner statt der eigenen PoB-Builds.
  const noBuilds = path.join(out, 'no-builds');
  fs.mkdirSync(noBuilds, { recursive: true });
  process.env.COMPANION_POB_BUILDS = noBuilds;

  const code = fs.readFileSync(path.join(root, 'test/fixtures/deadeye.code'), 'utf8');
  clipboard.readText = async () => code;
  shell.openExternal = async () => undefined;
  const item = fs.readFileSync(path.join(root, '..', 'core', 'test', 'fixtures', 'rare-ring.txt'), 'utf8');

  const log = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (wc, expr, ms = 30_000) => {
    for (let t = 0; t < ms; t += 200) {
      if (await wc.executeJavaScript(expr)) return;
      await wait(200);
    }
    throw new Error(`timeout waiting for ${expr}`);
  };
  const snap = async (wc, name) => {
    wc.invalidate();
    await wait(500);
    fs.writeFileSync(path.join(out, name), (await wc.capturePage()).toPNG());
    log.push(`saved ${name}`);
  };

  let mainWin = null;
  let overlayWc = null;
  const started = () => mainWin && overlayWc && void run();
  app.on('browser-window-created', (_e, win) => {
    win.webContents.once('did-finish-load', () => {
      const url = win.webContents.getURL();
      if (url.endsWith('app.html')) mainWin = win;
      if (url.endsWith('overlay.html')) overlayWc = win.webContents;
      started();
    });
  });

  async function run() {
    const wc = mainWin.webContents;
    const js = (c) => wc.executeJavaScript(c);
    try {
      mainWin.setSize(1240, 820);
      wc.setBackgroundThrottling(false);
      for (const w of [wc, overlayWc]) await w.insertCSS('*, *::before { animation: none !important; transition: none !important; }');
      // Hinweise und die Versionszeile der Entwicklerversion gehören nicht auf die Bilder.
      await wc.insertCSS('#msg, .version-line { display: none !important; }');
      await until(wc, `document.getElementById('engine-state').classList.contains('ready')`);
      await js(`document.getElementById('empty-paste').click()`);
      await until(wc, `!document.getElementById('char').hidden`);
      await wait(800);
      await js(`document.getElementById('msg').hidden = true`);
      await snap(wc, 'character.png');

      await js(`document.querySelector('.nav-item[data-page=guide]').click()`);
      await snap(wc, 'how-to-use.png');

      // Ziel-Build: derselbe Demo-Build, mit einem gerade gefundenen Item als Beispiel für den Abgleich.
      await js(`document.querySelector('.nav-item[data-page=target]').click()`);
      await js(`document.getElementById('target-paste').click()`);
      await until(wc, `!document.getElementById('target-progress-card').hidden`);
      await js(`document.getElementById('msg').hidden = true`);
      await snap(wc, 'target-build.png');

      // Item-Check-Overlay mit einem Ring aus den Test-Fixtures.
      await globalThis.__companionTest.itemCheck(item);
      await until(overlayWc, `!!document.querySelector('#root .card')`);
      await wait(600);
      await snap(overlayWc, 'item-check.png');
    } catch (err) {
      log.push(`error: ${err.stack ?? err}`);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n') + '\n');
    app.exit(0);
  }

  require(path.join(root, 'dist/main.js'));
};
