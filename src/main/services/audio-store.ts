import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { LIMITS } from '../../shared/constants'

export class AudioError extends Error {
  constructor(
    readonly code: 'INVALID_AUDIO' | 'EMPTY_RECORDING' | 'DISK_FULL' | 'AUDIO_WRITE_FAILED',
    message: string
  ) {
    super(message)
  }
}

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  dataBytes: number
  durationMs: number
}

/** Parses and checks the canonical 44-byte PCM WAV header produced by the renderer recorder. */
export function parseWav(buf: Uint8Array): WavInfo {
  if (buf.byteLength < 44) throw new AudioError('INVALID_AUDIO', 'Audio data is too short.')
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (o: number): string => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') {
    throw new AudioError('INVALID_AUDIO', 'Audio data is not a PCM WAV file.')
  }
  const format = dv.getUint16(20, true)
  const channels = dv.getUint16(22, true)
  const sampleRate = dv.getUint32(24, true)
  const bitsPerSample = dv.getUint16(34, true)
  const dataBytes = dv.getUint32(40, true)
  if (format !== 1 || channels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) {
    throw new AudioError('INVALID_AUDIO', 'Audio must be 16 kHz mono 16-bit PCM.')
  }
  if (dataBytes !== buf.byteLength - 44) throw new AudioError('INVALID_AUDIO', 'Audio data length mismatch.')
  return { sampleRate, channels, bitsPerSample, dataBytes, durationMs: (dataBytes / 2 / sampleRate) * 1000 }
}

/** Peak below this (full scale = 1) is treated as silence. */
const SILENCE_PEAK = 0.01

/** Peak and RMS of the PCM payload (0..1), computed here rather than trusted from the renderer. */
export function measureLevels(buf: Uint8Array): { peak: number; rms: number } {
  const n = Math.floor((buf.byteLength - 44) / 2)
  if (n <= 0) return { peak: 0, rms: 0 }
  const dv = new DataView(buf.buffer, buf.byteOffset + 44, n * 2)
  let peak = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = dv.getInt16(i * 2, true) / 32768
    const a = Math.abs(v)
    if (a > peak) peak = a
    sum += v * v
  }
  return { peak, rms: Math.sqrt(sum / n) }
}

export function assertNotEmpty(info: WavInfo, peak: number): void {
  if (info.durationMs < LIMITS.minRecordingMs) {
    throw new AudioError(
      'EMPTY_RECORDING',
      'The recording was too short. Hold the recording a little longer.'
    )
  }
  if (peak < SILENCE_PEAK) {
    throw new AudioError(
      'EMPTY_RECORDING',
      'No sound was picked up. Check that the right microphone is selected and unmuted.'
    )
  }
}

/** Writes the audio atomically (tmp + rename) into the app's private audio directory. */
export async function saveWav(dir: string, buf: Uint8Array): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${randomUUID()}.wav`)
  const tmp = file + '.tmp'
  try {
    await fs.writeFile(tmp, buf)
    await fs.rename(tmp, file)
    return file
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
      throw new AudioError(
        'DISK_FULL',
        'The disk is full, so the recording could not be saved. Free some space and try again.'
      )
    }
    throw new AudioError('AUDIO_WRITE_FAILED', 'The recording could not be saved.')
  }
}

/** Only deletes files inside the audio directory. */
export async function deleteAudioFile(dir: string, file: string): Promise<void> {
  const resolved = path.resolve(file)
  if (path.dirname(resolved) !== path.resolve(dir)) return
  await fs.rm(resolved, { force: true })
}
