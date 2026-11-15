import { contextBridge, ipcRenderer } from 'electron';
import type { BuildView } from '../shared/types';

type Result = { ok: true; view: BuildView } | { ok: false; error: string; view: BuildView };

const api = {
  getView: (): Promise<BuildView> => ipcRenderer.invoke('view:get'),
  onView: (cb: (v: BuildView) => void) => {
    ipcRenderer.on('view:changed', (_e, v: BuildView) => cb(v));
  },
  /** Reads a Path of Building code from the clipboard (once, on click) and calculates it. */
  pasteBuild: (): Promise<Result> => ipcRenderer.invoke('build:paste'),
  setNinjaLink: (link: string): Promise<Result> => ipcRenderer.invoke('ninja:set', link),
  clearNinja: (): Promise<Result> => ipcRenderer.invoke('ninja:clear'),
  refreshNinja: (): Promise<Result> => ipcRenderer.invoke('ninja:refresh'),
  openNinja: (): Promise<void> => ipcRenderer.invoke('ninja:open'),
};

export type Api = typeof api;
contextBridge.exposeInMainWorld('api', api);
