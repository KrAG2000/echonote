import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * GNOME custom keyboard shortcut that runs `<EchoNote> --toggle`.
 *
 * On GNOME/Wayland, Electron's globalShortcut cannot grab keys (tested on GNOME 50 with
 * Electron 44: registration returns false even with the GlobalShortcutsPortal feature). A
 * GNOME custom shortcut is handled by the compositor itself, so it works from any app; the
 * spawned `--toggle` process hands off to the running instance through Electron's
 * single-instance lock and exits.
 *
 * gsettings is invoked with execFile (no shell) and fixed arguments.
 */
const SCHEMA = 'org.gnome.settings-daemon.plugins.media-keys'
const LIST_KEY = 'custom-keybindings'
const ENTRY_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/echonote/'
const ENTRY_SCHEMA = `${SCHEMA}.custom-keybinding:${ENTRY_PATH}`

export function isGnome(): boolean {
  return (process.env.XDG_CURRENT_DESKTOP ?? '').toUpperCase().includes('GNOME')
}

/** Electron accelerator ("Alt+Shift+Space") -> GTK accelerator ("<Alt><Shift>space"). */
export function toGtkAccelerator(acc: string): string {
  const parts = acc.split('+')
  const key = parts.pop() ?? ''
  const mods = parts
    .map((m) => {
      const l = m.toLowerCase()
      if (l === 'ctrl' || l === 'control' || l === 'commandorcontrol' || l === 'cmdorctrl') return '<Control>'
      if (l === 'alt') return '<Alt>'
      if (l === 'shift') return '<Shift>'
      if (l === 'super' || l === 'meta' || l === 'command' || l === 'cmd') return '<Super>'
      return ''
    })
    .join('')
  const keyMap: Record<string, string> = {
    Space: 'space',
    Enter: 'Return',
    Return: 'Return',
    Tab: 'Tab',
    Backspace: 'BackSpace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'Page_Up',
    PageDown: 'Page_Down',
    Up: 'Up',
    Down: 'Down',
    Left: 'Left',
    Right: 'Right'
  }
  const k = keyMap[key] ?? (/^[A-Za-z]$/.test(key) ? key.toLowerCase() : key)
  return mods + k
}

/** The executable (plus app path in development) that starts EchoNote. */
export function appCommand(): string[] {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE]
  return process.defaultApp ? [process.execPath, process.argv[1] ?? '.'] : [process.execPath]
}

async function gsettings(...args: string[]): Promise<string> {
  const { stdout } = await run('gsettings', args, { timeout: 5000 })
  return stdout.trim()
}

function parseList(v: string): string[] {
  return [...v.matchAll(/'([^']*)'/g)].map((m) => m[1])
}

function gvString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export async function isInstalled(): Promise<boolean> {
  if (!isGnome()) return false
  try {
    return parseList(await gsettings('get', SCHEMA, LIST_KEY)).includes(ENTRY_PATH)
  } catch {
    return false
  }
}

/** `command` is the full shell command GNOME runs (see toggle-pipe.ts shortcutCommand). */
export async function install(accelerator: string, command: string): Promise<void> {
  const list = parseList(await gsettings('get', SCHEMA, LIST_KEY))
  // gsettings parses values as GVariant text, so strings must be serialized as GVariant strings.
  await gsettings('set', ENTRY_SCHEMA, 'name', gvString('EchoNote: start/stop recording'))
  await gsettings('set', ENTRY_SCHEMA, 'command', gvString(command))
  await gsettings('set', ENTRY_SCHEMA, 'binding', gvString(toGtkAccelerator(accelerator)))
  if (!list.includes(ENTRY_PATH)) {
    await gsettings('set', SCHEMA, LIST_KEY, `[${[...list, ENTRY_PATH].map(gvString).join(', ')}]`)
  }
}

export async function uninstall(): Promise<void> {
  const list = parseList(await gsettings('get', SCHEMA, LIST_KEY))
  if (list.includes(ENTRY_PATH)) {
    const next = list.filter((p) => p !== ENTRY_PATH)
    await gsettings('set', SCHEMA, LIST_KEY, next.length ? `[${next.map(gvString).join(', ')}]` : '@as []')
  }
  for (const key of ['name', 'command', 'binding']) {
    await gsettings('reset', ENTRY_SCHEMA, key).catch(() => undefined)
  }
}
