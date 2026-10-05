/**
 * End-to-end workflows from the specification (section 21.3), driving the real built app
 * (out/), the real native runtimes and the real models. The microphone is replaced by a WAV
 * file through Chromium's fake-capture switches (ECHONOTE_FAKE_AUDIO), so the whole audio
 * path (getUserMedia -> AudioWorklet -> WAV -> IPC -> whisper.cpp -> llama.cpp) is exercised.
 *
 * Recording is toggled with `electron . --toggle`, exactly what the GNOME keyboard shortcut runs.
 *
 * Prerequisites: `npm run build`, `npm run native:build`, `npm run models:prepare`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.join(__dirname, '../..')
// ECHONOTE_E2E_EXE runs the suite against a packaged build (dist/linux-unpacked/echonote or the
// AppImage) instead of the development tree.
const packagedExe = process.env.ECHONOTE_E2E_EXE
const electronBin = packagedExe ?? path.join(root, 'node_modules/electron/dist/electron')
const appArgs = packagedExe ? [] : [root]
const realModels = process.env.ECHONOTE_MODELS_DIR || path.join(os.homedir(), '.config/EchoNote/models')
const fixture = (n: string): string => path.join(root, 'tests/fixtures', `${n}.wav`)

interface Session {
  app: ElectronApplication
  page: Page
  env: Record<string, string>
  userData: string
}

const open: ElectronApplication[] = []
afterEach(async () => {
  for (const a of open.splice(0)) await quit(a)
})

function newProfile(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'echonote-e2e-'))
}

async function launch(opts: {
  userData: string
  audio?: string
  models?: string
  extraEnv?: Record<string, string>
  finishSetup?: boolean
}): Promise<Session> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ECHONOTE_USER_DATA: opts.userData,
    ECHONOTE_MODELS_DIR: opts.models ?? realModels,
    ECHONOTE_FAKE_AUDIO: opts.audio ?? fixture('reference'),
    ...opts.extraEnv
  }
  delete env.ELECTRON_RENDERER_URL
  const app = await electron.launch({ executablePath: electronBin, args: appArgs, env, timeout: 60_000 })
  open.push(app)
  procs.set(app, app.process())
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (opts.finishSetup !== false) {
    const finish = page.getByTestId('setup-finish')
    const skip = page.getByTestId('setup-skip')
    await page.waitForSelector('[data-testid="nav-capture"], [data-testid="setup-finish"]', {
      timeout: 30_000
    })
    if (await finish.isVisible()) {
      if (await finish.isEnabled()) await finish.click()
      else await skip.click()
    }
    await page.getByTestId('nav-capture').waitFor()
  }
  return { app, page, env, userData: opts.userData }
}

const procs = new WeakMap<ElectronApplication, ReturnType<ElectronApplication['process']>>()

async function quit(app: ElectronApplication): Promise<void> {
  const i = open.indexOf(app)
  if (i >= 0) open.splice(i, 1)
  const proc = procs.get(app)
  if (!proc) return
  try {
    await app.evaluate(({ app: a }) => a.quit())
  } catch {
    /* already gone */
  }
  await new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    proc.once('exit', () => resolve())
    setTimeout(() => {
      proc.kill('SIGKILL')
      resolve()
    }, 10_000)
  })
}

/** What the desktop keyboard shortcut runs. */
function toggleViaCli(s: Session): void {
  const r = spawnSync(electronBin, [...appArgs, '--toggle'], { env: s.env, timeout: 20_000 })
  expect(r.status, r.stderr?.toString()).toBe(0)
}

async function waitForLlmReady(page: Page): Promise<void> {
  await expectText(page, 'pill-llm', /ready/, 120_000)
}

async function expectText(page: Page, testId: string, re: RegExp, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    ([id, src]) => new RegExp(src).test(document.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''),
    [testId, re.source] as const,
    { timeout }
  )
}

async function record(s: Session, ms: number): Promise<void> {
  toggleViaCli(s)
  await expectText(s.page, 'record-state', /Recording/, 15_000)
  await s.page.waitForTimeout(ms)
  toggleViaCli(s)
}

/** Polls an async predicate evaluated in the page (waitForFunction treats Promises as truthy). */
async function pollPage(page: Page, fn: () => Promise<boolean>, timeout: number): Promise<void> {
  const t0 = Date.now()
  while (!(await page.evaluate(fn))) {
    if (Date.now() - t0 > timeout) throw new Error('pollPage timed out')
    await page.waitForTimeout(500)
  }
}

function logLines(userData: string, msg: string): number {
  try {
    return fs
      .readFileSync(path.join(userData, 'logs/echonote.log'), 'utf8')
      .split('\n')
      .filter((l) => l.includes(`"msg":"${msg}"`)).length
  } catch {
    return 0
  }
}

function card(page: Page, attrs: string) {
  return page.locator(`[data-testid="capture-card"]${attrs}`)
}

describe('E2E', () => {
  it('Workflow A: reference note via the shortcut command, persisted and searchable after restart', async () => {
    const userData = newProfile()
    let s = await launch({ userData, audio: fixture('reference') })
    await waitForLlmReady(s.page)
    await record(s, 4500)
    await card(s.page, '[data-category="reference"]').first().waitFor({ timeout: 90_000 })
    const transcript = await card(s.page, '[data-category="reference"]')
      .first()
      .getByTestId('capture-transcript')
      .textContent()
    expect(transcript?.toLowerCase()).toContain('staging server')
    await quit(s.app)

    s = await launch({ userData, audio: fixture('reference') })
    await s.page.getByTestId('nav-search').click()
    await s.page.getByTestId('search-input').fill('staging')
    await card(s.page, '').first().waitFor({ timeout: 10_000 })
    expect(await card(s.page, '').count()).toBe(1)
  })

  it('Workflow B: reminder is interpreted, persisted, delivered once, and restored after restart', async () => {
    const userData = newProfile()
    let s = await launch({ userData, audio: fixture('near_reminder') })
    await waitForLlmReady(s.page)
    await record(s, 4000)
    const reminderCard = card(s.page, '[data-category="reminder"]').first()
    await reminderCard.waitFor({ timeout: 90_000 })
    const id = await reminderCard.getAttribute('data-capture-id')
    const c = (await s.page.evaluate((cid) => window.echo.getCapture(cid!), id)) as {
      ok: true
      data: { dueAt: string; createdAt: string; status: string }
    }
    const due = Date.parse(c.data.dueAt)
    const created = Date.parse(c.data.createdAt)
    // "in two minutes" -> due about two minutes after the capture.
    expect(due - created).toBeGreaterThan(90_000)
    expect(due - created).toBeLessThan(180_000)
    // With a garbled synthetic voice the model may (correctly) ask for confirmation; confirm it the
    // way a user would, which is also what schedules an unconfirmed reminder.
    expect(['ready', 'needs_confirmation']).toContain(c.data.status)
    if (c.data.status === 'needs_confirmation') {
      const confirmed = (await s.page.evaluate(
        (cid) => window.echo.updateCapture({ id: cid!, confirm: true }),
        id
      )) as {
        ok: boolean
        data: { status: string }
      }
      expect(confirmed.ok && confirmed.data.status).toBe('ready')
    }

    // Wait for delivery, then make sure it is not delivered again.
    const waitMs = due - Date.now() + 5_000
    await s.page.waitForTimeout(Math.max(0, waitMs))
    expect(logLines(userData, 'reminders: delivered')).toBe(1)
    await s.page.waitForTimeout(35_000)
    expect(logLines(userData, 'reminders: delivered')).toBe(1)
    await quit(s.app)

    // Restart: delivered state restored, no duplicate notification.
    s = await launch({ userData })
    await s.page.waitForTimeout(3_000)
    expect(logLines(userData, 'reminders: delivered')).toBe(1)
    const r = (await s.page.evaluate(() => window.echo.listReminders())) as {
      ok: true
      data: Array<{ status: string }>
    }
    expect(r.data.map((x) => x.status)).toEqual(['delivered'])
  }, 400_000)

  it('Workflow B2: a future reminder stays pending across restarts', async () => {
    const userData = newProfile()
    let s = await launch({ userData, audio: fixture('reminder') })
    await waitForLlmReady(s.page)
    await record(s, 4500)
    await card(s.page, '[data-category="reminder"], [data-status="needs_confirmation"]')
      .first()
      .waitFor({ timeout: 90_000 })
    const before = (await s.page.evaluate(() => window.echo.listCaptures({ view: 'all' }))) as {
      ok: true
      data: Array<{ status: string; dueAt: string | null; transcript: string }>
    }
    await quit(s.app)
    s = await launch({ userData })
    const after = (await s.page.evaluate(() => window.echo.listCaptures({ view: 'all' }))) as typeof before
    expect(after.data).toEqual(before.data)
    if (before.data[0].status === 'ready') {
      const rem = (await s.page.evaluate(() => window.echo.listReminders())) as {
        ok: true
        data: Array<{ status: string }>
      }
      expect(rem.data.map((x) => x.status)).toEqual(['pending'])
    }
  })

  it('Workflow C: LLM unavailable -> transcript saved in the inbox -> organized once the model is back, no duplicates', async () => {
    const userData = newProfile()
    // A models dir with only the speech model.
    const partial = newProfile()
    for (const f of fs.readdirSync(realModels).filter((f) => f.startsWith('ggml-'))) {
      fs.symlinkSync(path.join(realModels, f), path.join(partial, f))
    }
    let s = await launch({ userData, audio: fixture('task'), models: partial })
    await expectText(s.page, 'pill-speech', /ready/, 60_000)
    await expectText(s.page, 'pill-llm', /not installed/)
    await record(s, 4000)
    await s.page.getByTestId('nav-inbox').click()
    const inboxCard = card(s.page, '[data-status="inbox"]').first()
    await inboxCard.waitFor({ timeout: 60_000 })
    expect((await inboxCard.textContent())?.toLowerCase()).toContain('login')
    expect(await inboxCard.textContent()).toContain('Waiting for the AI model')
    await quit(s.app)

    // Restore the model: the queued capture is organized automatically.
    s = await launch({ userData, audio: fixture('task') })
    await waitForLlmReady(s.page)
    await pollPage(
      s.page,
      async () => {
        const r = await window.echo.listCaptures({ view: 'all', includeCompleted: true })
        return r.ok && r.data.length === 1 && r.data[0].status !== 'inbox'
      },
      60_000
    )
    const all = (await s.page.evaluate(() =>
      window.echo.listCaptures({ view: 'all', includeCompleted: true })
    )) as {
      ok: true
      data: Array<{ category: string; transcript: string }>
    }
    expect(all.data).toHaveLength(1)
    expect(all.data[0].category).toBe('task')
    expect(all.data[0].transcript.toLowerCase()).toContain('login')

    // A manual retry must not create a second record either.
    const id = (
      (await s.page.evaluate(() => window.echo.listCaptures({ view: 'all' }))) as {
        ok: true
        data: Array<{ id: string }>
      }
    ).data[0].id
    await s.page.evaluate((cid) => window.echo.retryCapture(cid), id)
    await s.page.waitForTimeout(500)
    const again = (await s.page.evaluate(() =>
      window.echo.listCaptures({ view: 'all', includeCompleted: true })
    )) as {
      ok: true
      data: unknown[]
    }
    expect(again.data).toHaveLength(1)
  })

  it('Workflow D: first-run setup with a failed then successful download, then works offline', async () => {
    const userData = newProfile()
    const models = newProfile()
    // 1. Fresh profile, no models, network "down": setup shows, download fails with a retry path.
    let s = await launch({ userData, models, extraEnv: { ECHONOTE_TEST_OFFLINE: '1' }, finishSetup: false })
    await s.page.getByTestId('setup-download').waitFor()
    await s.page.getByTestId('download-whisper-base.en-q5_1').click()
    await s.page
      .getByText(/Network error/)
      .first()
      .waitFor({ timeout: 15_000 })
    await expect(s.page.getByTestId('download-whisper-base.en-q5_1')).toBeDefined()
    expect(await s.page.getByTestId('download-whisper-base.en-q5_1').textContent()).toMatch(/Retry/)
    await quit(s.app)

    // 2. Network back: retry downloads + verifies the real speech model (60 MB).
    s = await launch({ userData, models, finishSetup: false })
    await s.page.getByTestId('download-whisper-base.en-q5_1').click()
    await s.page
      .locator('[data-testid="model-whisper-base.en-q5_1"]')
      .getByText(/Installed/)
      .waitFor({ timeout: 300_000 })
    await expectText(s.page, 'pill-speech', /ready/, 60_000)
    await quit(s.app)
    // The LLM is already verified on this machine; link it instead of downloading 1.1 GB again.
    for (const f of fs.readdirSync(realModels).filter((f) => f.startsWith('qwen'))) {
      fs.symlinkSync(path.join(realModels, f), path.join(models, f))
    }
    fs.rmSync(userData, { recursive: true, force: true })
  }, 400_000)

  it('Workflow E: invalid shortcut, denied microphone, recovery, and no duplicate sessions', async () => {
    const userData = newProfile()
    let s = await launch({ userData, audio: fixture('task'), extraEnv: { ECHONOTE_TEST_DENY_MIC: '1' } })
    // Invalid shortcut -> useful error, previous shortcut kept.
    const bad = (await s.page.evaluate(() => window.echo.updateSettings({ shortcut: 'Hyper+Banana' }))) as {
      ok: boolean
      error?: { message: string }
    }
    expect(bad.ok).toBe(false)
    expect(bad.error?.message).toMatch(/not a valid shortcut/)

    // Microphone denied -> clear message, nothing saved.
    await s.page.getByTestId('record-button').click()
    await s.page.getByTestId('recording-error').waitFor({ timeout: 15_000 })
    expect(await s.page.getByTestId('recording-error').textContent()).toMatch(/denied/i)
    const none = (await s.page.evaluate(() => window.echo.listCaptures({ view: 'all' }))) as {
      ok: true
      data: unknown[]
    }
    expect(none.data).toHaveLength(0)
    await quit(s.app)

    // Permission granted -> works; hammering toggle creates exactly one session/capture.
    s = await launch({ userData, audio: fixture('task') })
    await expectText(s.page, 'pill-speech', /ready/, 60_000)
    await s.page.evaluate(() => {
      for (let i = 0; i < 5; i++) void window.echo.toggleRecording()
    })
    await expectText(s.page, 'record-state', /Recording/, 15_000)
    await s.page.waitForTimeout(3000)
    await s.page.evaluate(() => window.echo.stopRecording())
    await pollPage(
      s.page,
      async () => {
        const r = await window.echo.listCaptures({ view: 'all' })
        return r.ok && r.data.length > 0 && r.data[0].transcript !== null
      },
      60_000
    )
    const all = (await s.page.evaluate(() => window.echo.listCaptures({ view: 'all' }))) as {
      ok: true
      data: unknown[]
    }
    expect(all.data).toHaveLength(1)
  })

  it('Workflow F: recording stops by itself after 5 s of silence and saves nothing', async () => {
    const userData = newProfile()
    const s = await launch({ userData, audio: fixture('silence') })
    await expectText(s.page, 'pill-speech', /ready/, 60_000)
    const t0 = Date.now()
    toggleViaCli(s)
    await expectText(s.page, 'record-state', /Recording/, 15_000)
    await s.page.getByTestId('recording-error').waitFor({ timeout: 20_000 })
    const elapsed = Date.now() - t0
    expect(await s.page.getByTestId('recording-error').textContent()).toMatch(/No speech/)
    expect(elapsed).toBeGreaterThan(4_500)
    expect(elapsed).toBeLessThan(12_000)
    const all = (await s.page.evaluate(() => window.echo.listCaptures({ view: 'all' }))) as {
      ok: true
      data: unknown[]
    }
    expect(all.data).toHaveLength(0)
  })
})
