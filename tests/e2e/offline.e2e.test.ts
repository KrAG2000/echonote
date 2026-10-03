/**
 * Workflow D (offline part): after models are installed, the app works with NO network.
 *
 * The app runs inside a fresh Linux user+network namespace (`unshare -rn`) that has only a
 * loopback interface, so any attempt to reach the internet fails. Inside a user namespace we
 * are uid 0, and Chromium refuses to run its sandbox as root, hence --no-sandbox for this test
 * only. Recording is toggled from outside with `--toggle` (the single-instance socket is a
 * filesystem socket, so it crosses network namespaces), and results are read from SQLite.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.join(__dirname, '../..')
// ECHONOTE_E2E_EXE runs the suite against a packaged build (dist/linux-unpacked/echonote or the
// AppImage) instead of the development tree.
const packagedExe = process.env.ECHONOTE_E2E_EXE
const electronBin = packagedExe ?? path.join(root, 'node_modules/electron/dist/electron')
const appArgs = packagedExe ? [] : [root]
const models = process.env.ECHONOTE_MODELS_DIR || path.join(os.homedir(), '.config/EchoNote/models')
const canUnshare = spawnSync('unshare', ['-rn', 'true']).status === 0

let child: ChildProcess | null = null
// The app runs in its own process group so the whole tree (AppImage runtime wrapper included)
// can be stopped together.
const stopTree = (sig: NodeJS.Signals): void => {
  if (child?.pid) {
    try {
      process.kill(-child.pid, sig)
    } catch {
      /* already gone */
    }
  }
}
afterAll(() => stopTree('SIGKILL'))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(fn: () => T | null | undefined | false, ms: number): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await sleep(250)
  }
}

describe.skipIf(!canUnshare)('Offline operation', () => {
  it('records, transcribes and organizes a note with no network interface', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'echonote-offline-'))
    const env = {
      ...process.env,
      ECHONOTE_USER_DATA: userData,
      ECHONOTE_MODELS_DIR: models,
      ECHONOTE_FAKE_AUDIO: path.join(root, 'tests/fixtures/idea.wav')
    }
    delete (env as Record<string, string | undefined>).ELECTRON_RENDERER_URL

    // Prove the namespace really is offline.
    const probe = spawnSync('unshare', [
      '-rn',
      'sh',
      '-c',
      'ip link set lo up; curl -s -m 3 https://huggingface.co'
    ])
    expect(probe.status).not.toBe(0)

    child = spawn(
      'unshare',
      ['-rn', 'sh', '-c', 'ip link set lo up && exec "$0" --no-sandbox "$@"', electronBin, ...appArgs],
      { env, stdio: 'ignore', detached: true }
    )
    const log = path.join(userData, 'logs/echonote.log')
    const read = (): string => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '')
    await waitFor(() => read().includes('runtime: llm prompt cache warmed'), 180_000)
    await sleep(1500) // renderer loaded

    const toggle = (): void => {
      const r = spawnSync(electronBin, [...appArgs, '--toggle'], { env, timeout: 20_000 })
      expect(r.status).toBe(0)
    }
    toggle()
    await waitFor(() => read().includes('recorder: start requested'), 10_000)
    await sleep(5000)
    toggle()

    const db = path.join(userData, 'echonote.db')
    const row = await waitFor(() => {
      if (!fs.existsSync(db)) return null
      const d = new DatabaseSync(db, { readOnly: true })
      try {
        return d
          .prepare(
            `SELECT transcript, category, status FROM captures WHERE status IN ('ready','needs_confirmation')`
          )
          .get() as { transcript: string; category: string; status: string } | undefined
      } catch {
        return null
      } finally {
        d.close()
      }
    }, 120_000)
    expect(row.transcript.toLowerCase()).toContain('tool')
    expect(row.category).toBe('idea')
    expect(read()).not.toMatch(/blocked request/) // nothing even tried to go out
    stopTree('SIGTERM')
    await waitFor(() => (!read().includes('app: stopped') ? null : true), 15_000)
  }, 400_000)
})
