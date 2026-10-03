import type { RecorderState, RecordingStatus } from '../../shared/types'
import { LIMITS } from '../../shared/constants'
import type { Logger } from '../logger'

/**
 * Single source of truth for the microphone session. The renderer owns the actual audio
 * capture (getUserMedia + AudioWorklet), but it only starts or stops on commands from here,
 * so the shortcut, tray, overlay and in-app button can never create two sessions.
 *
 *   idle -> starting -> recording -> stopping -> idle
 *
 * Toggles that arrive while starting/stopping are ignored. Watchdogs return the state to idle
 * if the renderer never answers.
 */
export class RecordingController {
  state: RecorderState = 'idle'
  startedAt: number | null = null
  lastError: { code: string; message: string } | null = null
  /** Timestamp of the most recent shortcut/button press, for latency instrumentation. */
  requestedAt: number | null = null

  private watchdog: NodeJS.Timeout | null = null
  private maxTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly sendCommand: (cmd: 'start' | 'stop' | 'cancel') => boolean,
    private readonly onChange: () => void,
    private readonly logger: Logger,
    private readonly timeouts = { startMs: 10_000, stopMs: 15_000 }
  ) {}

  status(): RecordingStatus {
    return { state: this.state, startedAt: this.startedAt, lastError: this.lastError }
  }

  toggle(source: string): void {
    if (this.state === 'idle') this.start(source)
    else if (this.state === 'recording') this.stop(source)
    else this.logger.debug('recorder: toggle ignored while transitioning', { state: this.state, source })
  }

  start(source: string): boolean {
    if (this.state !== 'idle') return false
    this.requestedAt = Date.now()
    this.lastError = null
    this.set('starting')
    this.logger.info('recorder: start requested', { source })
    if (!this.sendCommand('start')) {
      this.fail({
        code: 'RECORDING_FAILED',
        message: 'The recorder is not available. Reopen EchoNote and try again.'
      })
      return false
    }
    this.arm(this.timeouts.startMs, () =>
      this.fail({ code: 'RECORDING_FAILED', message: 'The microphone did not start in time.' })
    )
    return true
  }

  stop(source: string): boolean {
    if (this.state !== 'recording') return false
    this.logger.info('recorder: stop requested', { source })
    this.set('stopping')
    this.sendCommand('stop')
    this.arm(this.timeouts.stopMs, () =>
      this.fail({ code: 'RECORDING_FAILED', message: 'The recording could not be finalized.' })
    )
    return true
  }

  /** Renderer confirms the microphone is live. */
  onStarted(at: number): void {
    if (this.state !== 'starting') {
      // Late confirmation after a timeout/cancel: make sure the mic is released.
      this.sendCommand('cancel')
      return
    }
    this.disarm()
    this.startedAt = at
    this.set('recording')
    this.maxTimer = setTimeout(() => this.stop('max-duration'), LIMITS.maxRecordingMs)
  }

  /** Renderer delivered (or discarded) the audio. */
  onFinished(): void {
    this.disarm()
    this.startedAt = null
    this.set('idle')
  }

  onFailed(err: { code: string; message: string }): void {
    this.fail(err)
  }

  private fail(err: { code: string; message: string }): void {
    this.logger.warn('recorder: failed', { code: err.code })
    this.disarm()
    if (this.state === 'recording' || this.state === 'starting') this.sendCommand('cancel')
    this.lastError = err
    this.startedAt = null
    this.set('idle')
  }

  private set(s: RecorderState): void {
    this.state = s
    this.onChange()
  }

  private arm(ms: number, fn: () => void): void {
    this.disarm()
    this.watchdog = setTimeout(fn, ms)
  }

  private disarm(): void {
    if (this.watchdog) clearTimeout(this.watchdog)
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.watchdog = null
    this.maxTimer = null
  }
}
