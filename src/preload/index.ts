import { contextBridge, ipcRenderer } from 'electron'
import { IPC, PUSH_CHANNEL, type EchoApi } from '../shared/api'
import type { PushEvent } from '../shared/types'

// The renderer gets this narrow, typed API and nothing else: no ipcRenderer, no Node.
const invoke = <T>(channel: string, payload?: unknown): Promise<T> => ipcRenderer.invoke(channel, payload)

const api: EchoApi = {
  listCaptures: (q) => invoke(IPC.captureList, q),
  getCapture: (id) => invoke(IPC.captureGet, { id }),
  updateCapture: (u) => invoke(IPC.captureUpdate, u),
  deleteCapture: (id) => invoke(IPC.captureDelete, { id }),
  retryCapture: (id) => invoke(IPC.captureRetry, { id }),
  toggleRecording: () => invoke(IPC.captureToggle),
  startRecording: () => invoke(IPC.captureStart),
  stopRecording: () => invoke(IPC.captureStop),
  recorderReady: () => invoke(IPC.recorderReady),
  recorderStarted: (at) => invoke(IPC.recorderStarted, { at }),
  recorderFailed: (code, message) => invoke(IPC.recorderFailed, { code, message }),
  submitRecording: (p) => invoke(IPC.recorderSubmit, p),
  listReminders: () => invoke(IPC.reminderList),
  getStatus: () => invoke(IPC.statusGet),
  getSettings: () => invoke(IPC.settingsGet),
  updateSettings: (patch) => invoke(IPC.settingsUpdate, patch),
  downloadModel: (id) => invoke(IPC.modelsDownload, { id }),
  cancelDownload: (id) => invoke(IPC.modelsCancel, { id }),
  verifyModel: (id) => invoke(IPC.modelsVerify, { id }),
  retryLoad: (kind, force) => invoke(IPC.modelsRetryLoad, force === undefined ? { kind } : { kind, force }),
  diagnostics: () => invoke(IPC.diagnostics),
  exportDiagnostics: (includeTranscripts) => invoke(IPC.exportDiagnostics, { includeTranscripts }),
  openDataFolder: () => invoke(IPC.openDataFolder),
  deleteAllData: (includeModels) => invoke(IPC.deleteAllData, { confirm: 'DELETE', includeModels }),
  testNotification: () => invoke(IPC.testNotification),
  hideOverlay: () => invoke(IPC.hideOverlay),
  installDesktopShortcut: () => invoke(IPC.shortcutInstallDesktop),
  removeDesktopShortcut: () => invoke(IPC.shortcutRemoveDesktop),
  showMain: (view) => invoke(IPC.showMain, view ? { view } : undefined),
  quit: () => invoke(IPC.quit),
  onEvent: (cb) => {
    const listener = (_e: unknown, evt: PushEvent): void => cb(evt)
    ipcRenderer.on(PUSH_CHANNEL, listener)
    return () => ipcRenderer.removeListener(PUSH_CHANNEL, listener)
  }
}

contextBridge.exposeInMainWorld('echo', api)
