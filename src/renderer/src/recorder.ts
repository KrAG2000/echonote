/**
 * Microphone capture in the renderer: getUserMedia -> AudioContext(16 kHz) -> AudioWorklet.
 * Produces a 16-bit mono PCM WAV, which is exactly what whisper.cpp expects, so no ffmpeg
 * or resampling is needed elsewhere. The microphone stream is opened only between start()
 * and stop()/cancel(); nothing listens in between.
 */
export type RecorderErrorCode =
  'MIC_PERMISSION_DENIED' | 'NO_INPUT_DEVICE' | 'DEVICE_BUSY' | 'RECORDING_FAILED'

export class RecorderError extends Error {
  constructor(
    readonly code: RecorderErrorCode,
    message: string
  ) {
    super(message)
  }
}

export interface RecordingResult {
  wav: Uint8Array
  durationMs: number
  peak: number
  rms: number
  startedAt: number
  stoppedAt: number
}

const SAMPLE_RATE = 16000

export class Recorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private chunks: Float32Array[] = []
  private startedAt = 0
  private level = 0
  onLevel: ((level: number) => void) | null = null
  /** Called with the RMS of every audio chunk (4096 samples = 256 ms). */
  onChunk: ((rms: number) => void) | null = null
  /** Called if the input device disappears mid-recording. */
  onDeviceLost: (() => void) | null = null

  get active(): boolean {
    return this.stream !== null
  }

  async start(): Promise<void> {
    if (this.stream) return
    this.chunks = []
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      })
    } catch (err) {
      this.stream = null
      throw mapMediaError(err)
    }
    try {
      this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      await this.ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', document.baseURI).href)
      const source = this.ctx.createMediaStreamSource(this.stream)
      this.node = new AudioWorkletNode(this.ctx, 'echonote-capture')
      this.node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        this.chunks.push(e.data)
        let peak = 0
        for (let i = 0; i < e.data.length; i++) peak = Math.max(peak, Math.abs(e.data[i]))
        this.level = this.level * 0.6 + peak * 0.4
        this.onLevel?.(this.level)
        let sum = 0
        for (let i = 0; i < e.data.length; i++) sum += e.data[i] * e.data[i]
        this.onChunk?.(Math.sqrt(sum / e.data.length))
      }
      source.connect(this.node)
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      for (const track of this.stream.getAudioTracks()) {
        track.addEventListener('ended', () => this.onDeviceLost?.())
      }
      this.startedAt = Date.now()
    } catch (err) {
      await this.release()
      throw new RecorderError('RECORDING_FAILED', `Could not start audio capture: ${(err as Error).message}`)
    }
  }

  async stop(): Promise<RecordingResult> {
    if (!this.stream) throw new RecorderError('RECORDING_FAILED', 'Not recording.')
    const stoppedAt = Date.now()
    // Let the worklet flush its last partial batch.
    await new Promise((r) => setTimeout(r, 120))
    await this.release()
    const samples = concat(this.chunks)
    this.chunks = []
    let peak = 0
    let sum = 0
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i])
      if (a > peak) peak = a
      sum += samples[i] * samples[i]
    }
    return {
      wav: encodeWav(samples, SAMPLE_RATE),
      durationMs: (samples.length / SAMPLE_RATE) * 1000,
      peak: Math.min(1, peak),
      rms: samples.length ? Math.min(1, Math.sqrt(sum / samples.length)) : 0,
      startedAt: this.startedAt,
      stoppedAt
    }
  }

  async cancel(): Promise<void> {
    await this.release()
    this.chunks = []
  }

  private async release(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.node?.port.close()
    this.node?.disconnect()
    this.node = null
    if (this.ctx) await this.ctx.close().catch(() => undefined)
    this.ctx = null
    this.onLevel?.(0)
  }
}

function mapMediaError(err: unknown): RecorderError {
  const name = (err as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new RecorderError(
      'MIC_PERMISSION_DENIED',
      'Microphone access was denied. Allow microphone access for EchoNote in your system privacy settings, then try again.'
    )
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new RecorderError(
      'NO_INPUT_DEVICE',
      'No microphone was found. Connect a microphone and try again.'
    )
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new RecorderError(
      'DEVICE_BUSY',
      'The microphone is busy or unavailable. Close other apps using it and retry.'
    )
  }
  return new RecorderError('RECORDING_FAILED', `Microphone error: ${(err as Error)?.message ?? 'unknown'}`)
}

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Float32Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2)
  const dv = new DataView(buf)
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  dv.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true)
  dv.setUint16(32, 2, true)
  dv.setUint16(34, 16, true)
  str(36, 'data')
  dv.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(buf)
}
