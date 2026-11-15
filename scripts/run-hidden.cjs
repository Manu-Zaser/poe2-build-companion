// Bootstrap für unsichtbare Tests: unterdrückt JEDEN Electron-Fehlerdialog und schreibt Fehler ins Log.
// Aufruf: npx electron scripts/run-hidden.cjs <testskript> <ausgabe-ordner>
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [script, out] = process.argv.slice(-2);
fs.mkdirSync(out, { recursive: true });
const fail = (err) => {
  fs.appendFileSync(path.join(out, 'log.txt'), `error: ${err && err.stack ? err.stack : err}\n`);
  app.exit(1);
};
dialog.showErrorBox = (title, content) => fail(`${title}: ${content}`);
dialog.showMessageBox = async () => ({ response: 0 });
dialog.showMessageBoxSync = () => 0;
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
for (const m of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[m] = function () {};
setTimeout(() => fail('timeout after 90 s'), 90_000).unref();

try {
  require(path.resolve(script))(out);
} catch (err) {
  fail(err);
}
