import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Launch-at-login on Linux via an XDG autostart entry. Supported for the AppImage and RPM builds;
 * a development checkout has no stable executable to point at.
 */
export function autostartFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'autostart', 'echonote.desktop')
}

export function setLaunchAtLogin(enabled: boolean): { ok: boolean; message: string | null } {
  if (process.platform !== 'linux')
    return { ok: false, message: 'Launch at login is only implemented for Linux.' }
  const file = autostartFile()
  if (!enabled) {
    fs.rmSync(file, { force: true })
    return { ok: true, message: null }
  }
  // AppImage: the .AppImage file; RPM install: /opt/EchoNote/echonote. Not available from a dev checkout.
  const exe = process.env.APPIMAGE || (process.defaultApp ? null : process.execPath)
  if (!exe) {
    return { ok: false, message: 'Launch at login is available in the installed app only.' }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const quoted = `"${exe.replace(/(["\\`$])/g, '\\$1')}"`
  fs.writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=EchoNote',
      'Comment=Local voice notes, tasks and reminders',
      `Exec=${quoted} --hidden`,
      'X-GNOME-Autostart-enabled=true',
      'Terminal=false',
      ''
    ].join('\n')
  )
  return { ok: true, message: null }
}
