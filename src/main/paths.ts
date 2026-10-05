import path from 'node:path'
import { app } from 'electron'

/**
 * Immutable resources (binaries, manifest, icons) live in the app bundle; everything the app
 * writes lives under the per-user data directory (~/.config/EchoNote on Linux).
 *
 * Environment overrides (used by tests and development only):
 *   ECHONOTE_USER_DATA   alternate writable data directory
 *   ECHONOTE_MODELS_DIR  alternate model directory (share downloads between profiles)
 */
export interface AppPaths {
  resources: string
  binDir: string
  manifest: string
  icon: string
  trayIcon: string
  trayIconRecording: string
  trayIconDone: string
  userData: string
  database: string
  models: string
  audio: string
  logs: string
}

export function resolvePaths(): AppPaths {
  const resources = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources')
  const userData = app.getPath('userData')
  return {
    resources,
    binDir: path.join(resources, 'bin', `${process.platform}-${process.arch}`),
    manifest: path.join(resources, 'models.json'),
    icon: path.join(resources, 'icon.png'),
    trayIcon: path.join(resources, 'tray.png'),
    trayIconRecording: path.join(resources, 'tray-recording.png'),
    trayIconDone: path.join(resources, 'tray-done.png'),
    userData,
    database: path.join(userData, 'echonote.db'),
    models: process.env.ECHONOTE_MODELS_DIR || path.join(userData, 'models'),
    audio: path.join(userData, 'audio-pending'),
    logs: path.join(userData, 'logs')
  }
}
