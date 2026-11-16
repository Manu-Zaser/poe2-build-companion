// Invisible test of the "Path of Building 2 file" source: start only via scripts/run-hidden.cjs.
//   npx electron scripts/run-hidden.cjs scripts/file-ui.cjs <output folder>
// Uses its own builds folder (never the real PoB folder), hidden windows, no hotkey, no keys sent.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

module.exports = (out) => {
  process.env.COMPANION_TEST = '1';
  const root = path.join(__dirname, '..');
  const profile = path.join(out, 'profile');
  const builds = path.join(out, 'builds');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(builds, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(builds, { recursive: true });
  app.setPath('userData', profile);
  process.env.COMPANION_POB_BUILDS = builds;

  // Optional: FILE_UI_CODE=<build code file> and FILE_UI_NINJA=<poe.ninja character link> to test the item
  // pictures that come from the linked poe.ninja profile (network).
  if (process.env.FILE_UI_NINJA) {
    const m = process.env.FILE_UI_NINJA.match(/profile\/([^/]+)\/([^/]+)\/character\/([^/?#]+)/);
    if (m) {
      fs.writeFileSync(
        path.join(profile, 'companion.json'),
        JSON.stringify({ settings: { hotkey: 'Alt+D', ninja: { account: m[1], league: m[2], character: decodeURIComponent(m[3]) } } }),
      );
    }
  }
  const code = fs.readFileSync(process.env.FILE_UI_CODE ?? path.join(root, 'test/fixtures/deadeye.code'), 'utf8').trim();
  const xml = zlib.inflateSync(Buffer.from(code.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toString('utf8');
  const file = path.join(builds, 'My Deadeye.xml');
  fs.writeFileSync(file, xml);
  const gloves = fs.readFileSync(path.join(root, '..', 'price-check', 'test', 'fixtures', 'rare-gloves-advanced.txt'), 'utf8');

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

  app.on('browser-window-created', (_e, win) => {
    const wc = win.webContents;
    wc.once('did-finish-load', async () => {
      if (!wc.getURL().endsWith('app.html')) return;
      win.setSize(1360, 960);
      wc.setBackgroundThrottling(false);
      wc.on('console-message', (e) => log.push(`console: ${e.message}`));
      try {
        await wc.insertCSS('*, *::before { animation: none !important; transition: none !important; }');
        await until(wc, `document.getElementById('engine-state').classList.contains('ready')`);
        const js = (c) => wc.executeJavaScript(c);

        await js(`document.querySelector('.nav-item[data-page=source]').click()`);
        await until(wc, `document.querySelectorAll('.pob-file').length > 0`);
        log.push(`list: ${flat(await js(`document.getElementById('pob-files').innerText`))}`);
        await snap(wc, '1-source.png');

        await js(`document.querySelector('.pob-file .btn').click()`);
        await until(wc, `!document.getElementById('char').hidden && document.querySelector('.page.active').dataset.page === 'character'`);
        log.push(`header: ${await js(`document.getElementById('p-league').innerText`)} | ${await js(`document.getElementById('p-name').innerText`)} | ${await js(`document.getElementById('p-class').innerText`)} | ${flat(await js(`document.getElementById('p-meta').innerText`))}`);
        log.push(`refresh button hidden: ${await js(`document.getElementById('hero-refresh').hidden`)}`);
        await wait(1500); // pictures load from GGG's CDN
        const pics = await js(`[...document.querySelectorAll('#doll .cell.filled, #belt-items .cell, #jewels .cell')].map((c) => { const i = c.querySelector('img'); return i && i.naturalWidth > 0 ? 'img' : 'name'; })`);
        log.push(`pictures: ${pics.filter((p) => p === 'img').length} of ${pics.length} items`);
        await snap(wc, '2-character.png');

        // Equip something, then "save in PoB": the newer file replaces the local change.
        await globalThis.__companionTest.itemCheck(gloves);
        await globalThis.__companionTest.equipLast('Gloves');
        await until(wc, `!document.getElementById('local-changes').hidden`);
        log.push(`after equip: ${flat(await js(`document.getElementById('local-changes').innerText`))}`);

        await wait(300);
        fs.writeFileSync(file, xml.replace('level="100"', 'level="99"'));
        const t0 = Date.now();
        await until(wc, `document.getElementById('p-class').innerText.includes('Level 99')`, 15_000);
        log.push(`reloaded after save in ${Date.now() - t0} ms: ${await js(`document.getElementById('p-class').innerText`)} | msg: ${await js(`document.getElementById('msg').innerText`)}`);
        log.push(`local changes hidden after save: ${await js(`document.getElementById('local-changes').hidden`)}`);

        // A half-written file (PoB writes in place) must not break anything.
        fs.writeFileSync(file, xml.slice(0, 3000));
        await wait(400);
        fs.writeFileSync(file, xml.replace('level="100"', 'level="98"'));
        await until(wc, `document.getElementById('p-class').innerText.includes('Level 98')`, 15_000);
        log.push(`after half-written save: ${await js(`document.getElementById('p-class').innerText`)}`);

        const stored = JSON.parse(fs.readFileSync(path.join(profile, 'companion.json'), 'utf8'));
        log.push(`stored source: ${JSON.stringify(stored.build.source)} snapshotAt=${stored.build.snapshotAt}`);
        await snap(wc, '3-after-save.png');
      } catch (err) {
        log.push('error: ' + err.stack);
      }
      fs.writeFileSync(path.join(out, 'log.txt'), log.join('\n'));
      app.exit(0);
    });
  });
  require(path.join(root, 'dist/main.js'));
};
