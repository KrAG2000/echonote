import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { modelManifestSchema, type ModelManifest, type ModelManifestEntry } from '../../shared/schemas'
import type { ModelFileStatus } from '../../shared/types'
import type { Logger } from '../logger'

interface Marker {
  sha256: string
  size: number
  mtimeMs: number
}

interface Progress {
  downloading: boolean
  verifying: boolean
  downloadedBytes: number
  error: { code: string; message: string } | null
}

export class ModelError extends Error {
  constructor(
    readonly code:
      | 'DOWNLOAD_FAILED'
      | 'CHECKSUM_MISMATCH'
      | 'SIZE_MISMATCH'
      | 'DISK_FULL'
      | 'UNKNOWN_MODEL'
      | 'CORRUPTED_MODEL',
    message: string
  ) {
    super(message)
  }
}

export function loadManifest(file: string): ModelManifest {
  return modelManifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
}

/**
 * Owns model files in the writable models directory. Downloads go to `<file>.part` (resumable
 * with HTTP Range), are checked against the manifest size and SHA-256, and are then renamed
 * into place atomically, so a working model is never replaced by a partial file. A small
 * `<file>.verified.json` marker avoids re-hashing gigabytes on every launch.
 */
export class ModelManager extends EventEmitter {
  private progress = new Map<string, Progress>()
  private verified = new Set<string>()
  private inflight = new Map<string, Promise<void>>()
  private aborts = new Map<string, AbortController>()

  constructor(
    readonly manifest: ModelManifest,
    readonly dir: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    super()
    fs.mkdirSync(dir, { recursive: true })
  }

  entry(id: string): ModelManifestEntry | undefined {
    return this.manifest.models.find((m) => m.id === id)
  }

  pathFor(id: string): string {
    const e = this.entry(id)
    if (!e) throw new ModelError('UNKNOWN_MODEL', `Unknown model ${id}`)
    return path.join(this.dir, e.fileName)
  }

  isVerified(id: string): boolean {
    return this.verified.has(id)
  }

  statuses(): ModelFileStatus[] {
    return this.manifest.models.map((m) => this.status(m.id))
  }

  status(id: string): ModelFileStatus {
    const e = this.entry(id)!
    const p = this.progress.get(id)
    const file = this.pathFor(id)
    return {
      id: e.id,
      name: e.name,
      kind: e.kind,
      sizeBytes: e.sizeBytes,
      license: e.license,
      description: e.purpose,
      installed: fs.existsSync(file),
      verified: this.verified.has(id),
      downloading: p?.downloading ?? false,
      verifying: p?.verifying ?? false,
      downloadedBytes: p?.downloadedBytes ?? partSize(file),
      error: p?.error ?? null
    }
  }

  /**
   * Checks an installed file. Uses the marker when size and mtime are unchanged; otherwise
   * re-hashes. A file that fails verification is deleted so it can be re-downloaded.
   */
  async verify(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const e = this.entry(id)
    if (!e) return false
    const file = this.pathFor(id)
    let st: fs.Stats
    try {
      st = await fsp.stat(file)
    } catch {
      this.verified.delete(id)
      return false
    }
    const marker = readMarker(file)
    if (
      !opts.force &&
      marker &&
      marker.sha256 === e.sha256 &&
      marker.size === st.size &&
      marker.mtimeMs === st.mtimeMs
    ) {
      this.verified.add(id)
      return true
    }
    this.setProgress(id, { verifying: true, error: null })
    try {
      const ok = st.size === e.sizeBytes && (await sha256File(file)) === e.sha256
      if (ok) {
        writeMarker(file, { sha256: e.sha256, size: st.size, mtimeMs: st.mtimeMs })
        this.verified.add(id)
        this.setProgress(id, { verifying: false })
        return true
      }
      this.logger.warn('models: verification failed, removing file', { id })
      this.verified.delete(id)
      await fsp.rm(file, { force: true })
      await fsp.rm(markerPath(file), { force: true })
      this.setProgress(id, {
        verifying: false,
        error: {
          code: 'CORRUPTED_MODEL',
          message: 'The model file was corrupted and has been removed. Download it again.'
        }
      })
      return false
    } catch (err) {
      this.setProgress(id, {
        verifying: false,
        error: { code: 'CORRUPTED_MODEL', message: (err as Error).message }
      })
      return false
    }
  }

  /** Downloads and verifies a model. Concurrent calls for the same id share one download. */
  download(id: string): Promise<void> {
    const existing = this.inflight.get(id)
    if (existing) return existing
    const p = this.doDownload(id).finally(() => {
      this.inflight.delete(id)
      this.aborts.delete(id)
    })
    this.inflight.set(id, p)
    return p
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort()
  }

  private async doDownload(id: string): Promise<void> {
    const e = this.entry(id)
    if (!e) throw new ModelError('UNKNOWN_MODEL', `Unknown model ${id}`)
    if (await this.verify(id)) return

    const file = this.pathFor(id)
    const part = file + '.part'
    let have = partSize(file)
    if (have > e.sizeBytes) {
      await fsp.rm(part, { force: true })
      have = 0
    }

    const free = await freeBytes(this.dir)
    if (free !== null && free < e.sizeBytes - have + 50 * 1024 * 1024) {
      const err = new ModelError(
        'DISK_FULL',
        `Not enough disk space: ${fmtMB(e.sizeBytes - have)} needed, ${fmtMB(free)} free.`
      )
      this.setProgress(id, { downloading: false, error: { code: err.code, message: err.message } })
      throw err
    }

    const ac = new AbortController()
    this.aborts.set(id, ac)
    this.setProgress(id, { downloading: true, downloadedBytes: have, error: null })
    this.logger.info('models: download start', { id, resumeFrom: have })

    try {
      if (have < e.sizeBytes) {
        const res = await this.fetchImpl(e.url, {
          headers: have > 0 ? { Range: `bytes=${have}-` } : {},
          redirect: 'follow',
          signal: ac.signal
        })
        if (!(res.status === 200 || res.status === 206) || !res.body) {
          throw new ModelError('DOWNLOAD_FAILED', `Download failed (HTTP ${res.status}).`)
        }
        if (res.status === 200) have = 0 // server ignored Range: restart from scratch
        const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' })
        let received = have
        let lastEmit = 0
        try {
          const reader = res.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
            received += value.byteLength
            if (received > e.sizeBytes)
              throw new ModelError('SIZE_MISMATCH', 'Downloaded file is larger than expected.')
            if (Date.now() - lastEmit > 250) {
              lastEmit = Date.now()
              this.setProgress(id, { downloadedBytes: received })
            }
          }
        } finally {
          await new Promise<void>((resolve, reject) => {
            out.end(() => resolve())
            out.once('error', reject)
          })
        }
        this.setProgress(id, { downloadedBytes: received })
      }

      const size = (await fsp.stat(part)).size
      if (size !== e.sizeBytes) {
        throw new ModelError(
          'DOWNLOAD_FAILED',
          `Download incomplete (${fmtMB(size)} of ${fmtMB(e.sizeBytes)}). Retry to resume.`
        )
      }
      this.setProgress(id, { downloading: false, verifying: true })
      const hash = await sha256File(part)
      if (hash !== e.sha256) {
        await fsp.rm(part, { force: true })
        throw new ModelError(
          'CHECKSUM_MISMATCH',
          'The downloaded file failed its integrity check and was discarded.'
        )
      }
      await fsp.rename(part, file)
      const st = await fsp.stat(file)
      writeMarker(file, { sha256: e.sha256, size: st.size, mtimeMs: st.mtimeMs })
      this.verified.add(id)
      this.setProgress(id, {
        downloading: false,
        verifying: false,
        downloadedBytes: e.sizeBytes,
        error: null
      })
      this.logger.info('models: download complete', { id })
    } catch (err) {
      const me =
        err instanceof ModelError
          ? err
          : (err as NodeJS.ErrnoException).code === 'ENOSPC'
            ? new ModelError(
                'DISK_FULL',
                'The disk is full. Free some space and retry; the partial download is kept.'
              )
            : ac.signal.aborted
              ? new ModelError('DOWNLOAD_FAILED', 'Download cancelled. Retry to resume.')
              : new ModelError(
                  'DOWNLOAD_FAILED',
                  `Network error: ${(err as Error).message}. Retry to resume.`
                )
      this.logger.warn('models: download failed', { id, code: me.code, err: err as Error })
      this.setProgress(id, {
        downloading: false,
        verifying: false,
        error: { code: me.code, message: me.message }
      })
      throw me
    }
  }

  private setProgress(id: string, patch: Partial<Progress>): void {
    const cur = this.progress.get(id) ?? {
      downloading: false,
      verifying: false,
      downloadedBytes: 0,
      error: null
    }
    this.progress.set(id, { ...cur, ...patch })
    this.emit('progress', id)
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk)
  return hash.digest('hex')
}

const markerPath = (file: string): string => file + '.verified.json'

function readMarker(file: string): Marker | null {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(file), 'utf8'))
    return typeof m.sha256 === 'string' && typeof m.size === 'number' && typeof m.mtimeMs === 'number'
      ? m
      : null
  } catch {
    return null
  }
}

function writeMarker(file: string, m: Marker): void {
  fs.writeFileSync(markerPath(file), JSON.stringify(m))
}

function partSize(file: string): number {
  try {
    return fs.statSync(file + '.part').size
  } catch {
    return 0
  }
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await fsp.statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

const fmtMB = (b: number): string => `${Math.round(b / 1024 / 1024)} MB`
