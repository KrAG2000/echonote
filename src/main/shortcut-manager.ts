import { globalShortcut } from 'electron'
import type { Logger } from './logger'
import * as gnome from './gnome-shortcut'
import { shortcutCommand } from './toggle-pipe'
import type { ShortcutStatus } from '../shared/types'

/**
 * Registers the record/stop shortcut, in order of preference:
 *  1. Electron globalShortcut (works on X11 sessions),
 *  2. a GNOME custom keyboard shortcut running `echonote --toggle` (GNOME on Wayland, where
 *     Electron cannot grab keys) — installed only after the user clicks "Set up",
 *  3. none: the in-app button, the overlay and the tray menu still work.
 */
export class ShortcutManager {
  state: ShortcutStatus = {
    accelerator: '',
    registered: false,
    method: 'none',
    message: null,
    desktopShortcutAvailable: gnome.isGnome()
  }

  constructor(
    private readonly logger: Logger,
    private readonly onPress: () => void,
    /** Named pipe the desktop shortcut writes to (see toggle-pipe.ts). */
    private readonly pipePath: string,
    /** False for non-default profiles: they must not touch the desktop-wide GNOME shortcut. */
    private readonly manageDesktopShortcut = true
  ) {
    if (!manageDesktopShortcut) this.state.desktopShortcutAvailable = false
  }

  private desktopCommand(): string {
    return shortcutCommand(this.pipePath, gnome.appCommand())
  }

  async register(accelerator: string): Promise<ShortcutStatus> {
    const prev = this.state
    if (prev.method === 'global' && prev.accelerator) globalShortcut.unregister(prev.accelerator)

    let ok = false
    let invalid: string | null = null
    try {
      ok = globalShortcut.register(accelerator, () => this.onPress())
    } catch (err) {
      invalid = (err as Error).message
    }
    if (invalid) {
      if (prev.method === 'global' && prev.accelerator)
        globalShortcut.register(prev.accelerator, () => this.onPress())
      this.state = { ...prev }
      return { ...prev, registered: false, message: `"${accelerator}" is not a valid shortcut.` }
    }
    if (ok) {
      this.logger.info('shortcut: registered globally', { accelerator })
      this.state = { ...this.state, accelerator, registered: true, method: 'global', message: null }
      return this.state
    }

    if (gnome.isGnome() && this.manageDesktopShortcut) {
      if (await gnome.isInstalled()) {
        try {
          await gnome.install(accelerator, this.desktopCommand()) // update binding + command
          this.logger.info('shortcut: using GNOME custom shortcut', { accelerator })
          this.state = { ...this.state, accelerator, registered: true, method: 'desktop', message: null }
          return this.state
        } catch (err) {
          this.logger.warn('shortcut: GNOME update failed', { err: err as Error })
        }
      }
      this.state = {
        ...this.state,
        accelerator,
        registered: false,
        method: 'none',
        message:
          'This desktop does not let apps grab global keys directly. Click "Set up GNOME shortcut" to add it as a system keyboard shortcut.'
      }
      return this.state
    }

    this.state = {
      ...this.state,
      accelerator,
      registered: false,
      method: 'none',
      message: `"${accelerator}" could not be registered; another application may already use it. Choose a different shortcut, or bind a desktop keyboard shortcut to "echonote --toggle".`
    }
    return this.state
  }

  async installDesktopShortcut(accelerator: string): Promise<ShortcutStatus> {
    if (!gnome.isGnome()) throw new Error('Desktop shortcuts can only be set up automatically on GNOME.')
    if (!this.manageDesktopShortcut)
      throw new Error('Only the default EchoNote profile can set up the desktop shortcut.')
    await gnome.install(accelerator, this.desktopCommand())
    this.logger.info('shortcut: GNOME custom shortcut installed', { accelerator })
    this.state = { ...this.state, accelerator, registered: true, method: 'desktop', message: null }
    return this.state
  }

  async removeDesktopShortcut(): Promise<ShortcutStatus> {
    if (!this.manageDesktopShortcut) return this.state
    await gnome.uninstall()
    this.logger.info('shortcut: GNOME custom shortcut removed')
    return this.register(this.state.accelerator)
  }

  unregisterAll(): void {
    globalShortcut.unregisterAll()
  }
}
