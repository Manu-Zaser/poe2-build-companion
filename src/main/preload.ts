import { contextBridge, ipcRenderer } from 'electron';
import type { BuildView, OverlayContent, PobFileEntry } from '../shared/types';

type Result = { ok: true; view: BuildView } | { ok: false; error: string; view: BuildView };

// Shared by the main window and the overlay.
const api = {
  getView: (): Promise<BuildView> => ipcRenderer.invoke('view:get'),
  onView: (cb: (v: BuildView) => void) => {
    ipcRenderer.on('view:changed', (_e, v: BuildView) => cb(v));
  },
  /** Reads a Path of Building code from the clipboard (once, on click) and calculates it. */
  pasteBuild: (): Promise<Result> => ipcRenderer.invoke('build:paste'),
  /** Copies the current build code to the clipboard. */
  copyBuild: (): Promise<boolean> => ipcRenderer.invoke('build:copy'),
  /** Undoes all "Equip in my build" changes. */
  resetEquips: (): Promise<Result> => ipcRenderer.invoke('build:reset-equips'),
  setNinjaLink: (link: string): Promise<Result> => ipcRenderer.invoke('ninja:set', link),
  clearNinja: (): Promise<Result> => ipcRenderer.invoke('ninja:clear'),
  refreshNinja: (): Promise<Result> => ipcRenderer.invoke('ninja:refresh'),
  openNinja: (): Promise<void> => ipcRenderer.invoke('ninja:open'),
  /** Build files saved by Path of Building 2. */
  listPobFiles: (): Promise<{ dir: string; files: PobFileEntry[] }> => ipcRenderer.invoke('pobfile:list'),
  usePobFile: (path: string): Promise<Result> => ipcRenderer.invoke('pobfile:use', path),
  choosePobFile: (): Promise<Result | null> => ipcRenderer.invoke('pobfile:choose'),
  openPobFolder: (): Promise<void> => ipcRenderer.invoke('pobfile:open-folder'),
  onNotice: (cb: (n: { text: string; kind: 'ok' | 'error' }) => void) => {
    ipcRenderer.on('notice', (_e, n: { text: string; kind: 'ok' | 'error' }) => cb(n));
  },
  setHotkey: (acc: string): Promise<Result> => ipcRenderer.invoke('settings:hotkey', acc),
  resetOverlayPosition: (): Promise<Result> => ipcRenderer.invoke('settings:reset-overlay'),

  // Overlay
  onOverlayContent: (cb: (c: OverlayContent) => void) => {
    ipcRenderer.on('overlay:content', (_e, c: OverlayContent) => cb(c));
  },
  overlayReady: (size: { width: number; height: number }) => ipcRenderer.send('overlay:ready', size),
  hideOverlay: () => ipcRenderer.send('overlay:hide'),
  focusOverlay: () => ipcRenderer.send('overlay:focus'),
  overlayLeave: () => ipcRenderer.send('overlay:leave'),
  dragStart: () => ipcRenderer.send('overlay:drag-start'),
  dragMove: () => ipcRenderer.send('overlay:drag-move'),
  dragEnd: () => ipcRenderer.send('overlay:drag-end'),
  equip: (slot: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('overlay:equip', slot),
  openApp: () => ipcRenderer.send('overlay:open-app'),
};

export type Api = typeof api;
contextBridge.exposeInMainWorld('api', api);
