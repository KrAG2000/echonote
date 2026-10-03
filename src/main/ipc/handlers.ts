import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/api'
import {
  captureUpdateSchema,
  deleteAllSchema,
  exportDiagnosticsSchema,
  idPayloadSchema,
  listQuerySchema,
  modelIdPayloadSchema,
  recorderFailedSchema,
  recorderStartedSchema,
  recorderSubmitSchema,
  retryLoadSchema,
  settingsPatchSchema
} from '../../shared/schemas'
import type { Result } from '../../shared/types'
import { UserError, type EchoApp } from '../app'
import { ModelError } from '../services/model-manager'

const noPayload = z.undefined().or(z.null()).or(z.object({}).strict())
const showMainSchema = z
  .object({ view: z.string().max(20).optional() })
  .strict()
  .optional()

/**
 * Registers every IPC endpoint. Each handler:
 *  1. rejects calls from frames other than the app's own renderer,
 *  2. validates the payload with a strict zod schema (unknown keys, wrong types and
 *     oversized values are refused),
 *  3. returns a typed Result instead of throwing across the bridge.
 * No handler accepts file paths, shell commands or SQL from the renderer.
 */
export function registerIpc(echo: EchoApp): void {
  const handle = <S extends z.ZodTypeAny, R>(
    channel: string,
    schema: S,
    fn: (payload: z.infer<S>) => R | Promise<R>
  ): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, payload: unknown): Promise<Result<R>> => {
      if (!isTrustedSender(event)) {
        echo.logger.warn('ipc: rejected untrusted sender', { channel })
        return { ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden.' } }
      }
      const parsed = schema.safeParse(payload)
      if (!parsed.success) {
        echo.logger.warn('ipc: invalid payload', { channel, issue: parsed.error.issues[0]?.message })
        return { ok: false, error: { code: 'INVALID_REQUEST', message: 'Invalid request.' } }
      }
      try {
        return { ok: true, data: await fn(parsed.data) }
      } catch (err) {
        if (err instanceof UserError || err instanceof ModelError) {
          return { ok: false, error: { code: err.code, message: err.message } }
        }
        echo.logger.error('ipc: handler failed', { channel, err: err as Error })
        const code = (err as NodeJS.ErrnoException).code === 'ENOSPC' ? 'DISK_FULL' : 'INTERNAL'
        return {
          ok: false,
          error: {
            code,
            message:
              code === 'DISK_FULL'
                ? 'The disk is full. Free some space and try again.'
                : 'Something went wrong. See the log for details.'
          }
        }
      }
    })
  }

  handle(IPC.captureList, listQuerySchema, (q) => echo.captures.list(q))
  handle(IPC.captureGet, idPayloadSchema, ({ id }) => {
    const c = echo.captures.get(id)
    if (!c) throw new UserError('NOT_FOUND', 'That item no longer exists.')
    return c
  })
  handle(IPC.captureUpdate, captureUpdateSchema, (u) => echo.updateCapture(u))
  handle(IPC.captureDelete, idPayloadSchema, async ({ id }) => {
    await echo.deleteCapture(id)
    return null
  })
  handle(IPC.captureRetry, idPayloadSchema, ({ id }) => {
    const r = echo.pipeline.retry(id)
    if (!r.ok) throw new UserError('RETRY_UNAVAILABLE', r.message)
    return r.message
  })
  handle(IPC.captureToggle, noPayload, () => {
    echo.toggleRecording('button')
    return null
  })
  handle(IPC.captureStart, noPayload, () => {
    echo.recorder.start('button')
    return null
  })
  handle(IPC.captureStop, noPayload, () => {
    echo.recorder.stop('button')
    return null
  })
  handle(IPC.recorderReady, noPayload, () => {
    echo.onRecorderReady()
    return null
  })
  handle(IPC.recorderStarted, recorderStartedSchema, ({ at }) => {
    echo.recorder.onStarted(at)
    return null
  })
  handle(IPC.recorderFailed, recorderFailedSchema, (e) => {
    echo.recorder.onFailed(e)
    return null
  })
  handle(IPC.recorderSubmit, recorderSubmitSchema, (p) => echo.submitRecording(p))
  handle(IPC.reminderList, noPayload, () => echo.reminders.listWithCaptures(false))
  handle(IPC.statusGet, noPayload, () => echo.status())
  handle(IPC.settingsGet, noPayload, () => echo.settings)
  handle(IPC.settingsUpdate, settingsPatchSchema, (p) => echo.updateSettings(p))
  handle(IPC.modelsDownload, modelIdPayloadSchema, async ({ id }) => {
    if (!echo.models.entry(id)) throw new UserError('UNKNOWN_MODEL', 'Unknown model.')
    await echo.downloadModel(id)
    return null
  })
  handle(IPC.modelsCancel, modelIdPayloadSchema, ({ id }) => {
    echo.models.cancel(id)
    return null
  })
  handle(IPC.modelsVerify, modelIdPayloadSchema, ({ id }) => {
    if (!echo.models.entry(id)) throw new UserError('UNKNOWN_MODEL', 'Unknown model.')
    return echo.models.verify(id, { force: true })
  })
  handle(IPC.modelsRetryLoad, retryLoadSchema, async ({ kind, force }) => {
    await echo.retryLoad(kind, force ?? false)
    return null
  })
  handle(IPC.diagnostics, noPayload, () => echo.diagnostics())
  handle(IPC.exportDiagnostics, exportDiagnosticsSchema, ({ includeTranscripts }) =>
    echo.exportDiagnostics(includeTranscripts)
  )
  handle(IPC.openDataFolder, noPayload, async () => {
    await echo.openDataFolder()
    return null
  })
  handle(IPC.deleteAllData, deleteAllSchema, async ({ includeModels }) => {
    await echo.deleteAllData(includeModels)
    return null
  })
  handle(IPC.testNotification, noPayload, () => echo.testNotification())
  handle(IPC.hideOverlay, noPayload, () => {
    echo.windows.hideOverlay()
    return null
  })
  handle(IPC.shortcutInstallDesktop, noPayload, () => echo.installDesktopShortcut())
  handle(IPC.shortcutRemoveDesktop, noPayload, () => echo.removeDesktopShortcut())
  handle(IPC.showMain, showMainSchema, (p) => {
    echo.windows.showMain(p?.view)
    return null
  })
  handle(IPC.quit, noPayload, () => {
    setImmediate(() => app.quit())
    return null
  })
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl && url.startsWith(devUrl)) return true
  return url.startsWith('file://') && url.includes('/renderer/index.html')
}
