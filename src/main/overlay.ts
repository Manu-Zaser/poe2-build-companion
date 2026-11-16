import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { OverlayContent } from '../shared/types';
import { focusWindowByTitle, foregroundWindowTitle } from '@poe2/core/win32';
import { log } from './log';

/**
 * Item check overlay, built like the Price Check overlay: a frameless window above the game that
 * appears without taking the focus, stays open until closed (× or Esc), can be dragged from anywhere
 * and remembers where it was left. No timers that hide it, no automatic actions.
 */

const WIDTH = 380;
const alive = (w: BrowserWindow | null): w is BrowserWindow => !!w && !w.isDestroyed();

export interface OverlayOptions {
  gameTitle: string;
  getPosition: () => { x: number; y: number } | undefined;
  savePosition: (p: { x: number; y: number }) => void;
}

export class Overlay {
  private win: BrowserWindow | null = null;
  private placing = false;
  private drag: { cursor: Electron.Point; bounds: Electron.Rectangle } | null = null;
  private cursorAtCheck = { x: 0, y: 0 };
  private watch: NodeJS.Timeout | null = null;
  private gameWasFront = true;
  private quitting = false;

  constructor(private readonly opts: OverlayOptions) {}

  create() {
    const win = new BrowserWindow({
      width: WIDTH,
      height: 200,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      // Focusable so clicks reliably reach it over a fullscreen game; it appears without the focus.
      focusable: true,
      alwaysOnTop: true,
      webPreferences: { preload: join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    this.win = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    void win.loadFile(join(__dirname, 'overlay.html'));
    win.on('moved', () => {
      if (!alive(win) || this.placing || this.drag) return;
      const { x, y } = win.getBounds();
      this.opts.savePosition({ x, y });
    });
    // A crashed or hanging overlay must never leave an invisible window above the game.
    const recover = (why: string) => {
      log(`overlay ${why} – recreating`);
      if (this.quitting) return;
      if (alive(win)) win.destroy();
      if (this.win === win) this.create();
    };
    win.webContents.on('render-process-gone', (_e, d) => recover(`crashed (${d.reason})`));
    win.on('unresponsive', () => recover('not responding'));
  }

  get webContents() {
    return alive(this.win) ? this.win.webContents : null;
  }

  isOwnWindow(handle: bigint): boolean {
    return alive(this.win) && this.win.getNativeWindowHandle().readBigUInt64LE(0) === handle;
  }

  /** Sends new content; the overlay is placed once it reports its size. */
  show(content: OverlayContent) {
    if (!alive(this.win)) return;
    this.cursorAtCheck = screen.getCursorScreenPoint();
    this.win.webContents.send('overlay:content', content);
  }

  /** Called with the rendered size of the content. */
  place(size: { width: number; height: number }) {
    const win = this.win;
    if (!alive(win)) return;
    const width = Math.max(120, Math.ceil(Number(size.width) || WIDTH));
    const rawHeight = Math.ceil(Number(size.height) || 200);
    const origin = this.origin(width, rawHeight);
    const area = screen.getDisplayNearestPoint(origin).workArea;
    const height = Math.max(60, Math.min(rawHeight, area.height));
    const y = Math.max(area.y, Math.min(origin.y, area.y + area.height - height));
    this.placing = true;
    try {
      win.setBounds({ x: Math.round(origin.x), y: Math.round(y), width, height });
    } finally {
      setTimeout(() => (this.placing = false), 50);
    }
    if (!win.isVisible()) win.showInactive(); // the game keeps the focus
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    this.startWatch();
  }

  /** Open overlay stays where it is; otherwise the saved position; otherwise next to the cursor. */
  private origin(width: number, height: number) {
    if (alive(this.win) && this.win.isVisible()) {
      const b = this.win.getBounds();
      return { x: b.x, y: b.y };
    }
    const saved = this.opts.getPosition();
    if (saved) {
      const area = screen.getDisplayNearestPoint(saved).workArea;
      const onScreen = saved.x >= area.x - 50 && saved.x < area.x + area.width - 50 && saved.y >= area.y - 10 && saved.y < area.y + area.height - 50;
      if (onScreen) return saved;
    }
    const c = this.cursorAtCheck;
    const area = screen.getDisplayNearestPoint(c).workArea;
    return {
      x: Math.min(Math.max(c.x + 18, area.x), area.x + area.width - width),
      y: Math.min(Math.max(c.y - 40, area.y), area.y + area.height - height),
    };
  }

  hide() {
    if (!alive(this.win)) return;
    this.endDrag();
    this.stopWatch();
    this.returnFocus('overlay closed');
    this.win.hide();
  }

  focus() {
    if (alive(this.win)) this.win.focus();
  }

  /** Gives the keyboard back to the game if the overlay took it (after a click into it). */
  returnFocus(reason: string) {
    if (!alive(this.win) || !this.win.isFocused()) return;
    const ok = focusWindowByTitle(this.opts.gameTitle);
    log(`focus back to the game (${reason})${ok ? '' : ' – failed'}`);
  }

  // ---------- Dragging (the renderer reports start/move/end, the window follows the cursor) ----------

  startDrag() {
    if (!alive(this.win)) return;
    this.drag = { cursor: screen.getCursorScreenPoint(), bounds: this.win.getBounds() };
  }

  moveDrag() {
    if (!this.drag || !alive(this.win)) return;
    const p = screen.getCursorScreenPoint();
    this.placing = true;
    this.win.setPosition(this.drag.bounds.x + p.x - this.drag.cursor.x, this.drag.bounds.y + p.y - this.drag.cursor.y);
    this.placing = false;
  }

  endDrag() {
    if (!this.drag) return;
    this.drag = null;
    if (!alive(this.win)) return;
    const { x, y } = this.win.getBounds();
    this.opts.savePosition({ x, y });
  }

  // ---------- Stay on top after Alt+Tab ----------
  // Windows sometimes drops "always on top" when switching; when the game comes back to the front,
  // raise the overlay again. One window-title check per second – no input to the game.

  private startWatch() {
    if (this.watch) return;
    this.gameWasFront = foregroundWindowTitle() === this.opts.gameTitle;
    this.watch = setInterval(() => {
      if (!alive(this.win) || !this.win.isVisible()) return this.stopWatch();
      const gameNow = foregroundWindowTitle() === this.opts.gameTitle;
      if (gameNow && !this.gameWasFront && !this.drag) {
        this.win.setAlwaysOnTop(false);
        this.win.setAlwaysOnTop(true, 'screen-saver');
        this.win.moveTop();
      }
      this.gameWasFront = gameNow;
    }, 1000);
  }

  private stopWatch() {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
  }

  destroy() {
    this.quitting = true;
    this.stopWatch();
    if (alive(this.win)) this.win.destroy();
  }
}
