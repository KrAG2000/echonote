import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelManager, loadManifest } from '../../src/main/services/model-manager'
import { modelManifestSchema, type ModelManifest } from '../../src/shared/schemas'
import { nullLogger } from '../../src/main/logger'

const payload = crypto.randomBytes(256 * 1024)
const sha = crypto.createHash('sha256').update(payload).digest('hex')
let server: http.Server
let port = 0
let mode: 'ok' | 'corrupt' | 'cut' | 'norange' = 'ok'
const rangeRequests: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const range = req.headers.range
    if (range) rangeRequests.push(range)
    let body = payload
    if (mode === 'corrupt') body = Buffer.from(payload).fill(1, 0, 10)
    if (range && mode !== 'norange') {
      const start = Number(/bytes=(\d+)-/.exec(range)![1])
      res.writeHead(206, { 'content-length': body.length - start })
      res.end(body.subarray(start))
      return
    }
    if (mode === 'cut') {
      res.writeHead(200, { 'content-length': body.length })
      res.write(body.subarray(0, 100 * 1024))
      setTimeout(() => res.destroy(), 20)
      return
    }
    res.writeHead(200, { 'content-length': body.length })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as { port: number }).port
})
afterAll(() => server.close())

function manifest(): ModelManifest {
  return {
    schemaVersion: 1,
    models: [
      {
        id: 'test-model',
        name: 'Test',
        kind: 'llm',
        version: '1',
        fileName: 'test.gguf',
        url: 'https://huggingface.co/test/test.gguf',
        sizeBytes: payload.length,
        sha256: sha,
        license: 'MIT',
        licenseUrl: 'https://example.com',
        purpose: 'test',
        languages: ['en'],
        minMemoryMB: 1,
        runtime: { engine: 'llama.cpp' }
      }
    ]
  }
}

// Route the manifest's huggingface URL to the local test server.
const localFetch: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${port}/test.gguf`, init)

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'echonote-models-'))
}

describe('ModelManager', () => {
  it('downloads, verifies the checksum and installs atomically', async () => {
    mode = 'ok'
    const dir = tmpDir()
    const mm = new ModelManager(manifest(), dir, nullLogger, localFetch)
    await mm.download('test-model')
    expect(fs.readFileSync(path.join(dir, 'test.gguf')).equals(payload)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'test.gguf.part'))).toBe(false)
    expect(mm.status('test-model').verified).toBe(true)
  })

  it('rejects a corrupted download and never installs it', async () => {
    mode = 'corrupt'
    const dir = tmpDir()
    const mm = new ModelManager(manifest(), dir, nullLogger, localFetch)
    await expect(mm.download('test-model')).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' })
    expect(fs.existsSync(path.join(dir, 'test.gguf'))).toBe(false)
    expect(mm.status('test-model').error?.code).toBe('CHECKSUM_MISMATCH')
  })

  it('keeps a partial download after interruption and resumes with Range', async () => {
    const dir = tmpDir()
    const mm = new ModelManager(manifest(), dir, nullLogger, localFetch)
    mode = 'cut'
    await expect(mm.download('test-model')).rejects.toMatchObject({ code: 'DOWNLOAD_FAILED' })
    const partial = fs.statSync(path.join(dir, 'test.gguf.part')).size
    expect(partial).toBeGreaterThan(0)
    expect(fs.existsSync(path.join(dir, 'test.gguf'))).toBe(false)
    mode = 'ok'
    rangeRequests.length = 0
    await mm.download('test-model')
    expect(rangeRequests).toEqual([`bytes=${partial}-`])
    expect(fs.readFileSync(path.join(dir, 'test.gguf')).equals(payload)).toBe(true)
  })

  it('restarts from scratch when the server ignores Range', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'test.gguf.part'), payload.subarray(0, 1000))
    mode = 'norange'
    const mm = new ModelManager(manifest(), dir, nullLogger, localFetch)
    await mm.download('test-model')
    expect(fs.readFileSync(path.join(dir, 'test.gguf')).equals(payload)).toBe(true)
  })

  it('does not download an already verified file again', async () => {
    mode = 'ok'
    const dir = tmpDir()
    let calls = 0
    const counting: typeof fetch = (u, i) => {
      calls++
      return localFetch(u, i)
    }
    const mm = new ModelManager(manifest(), dir, nullLogger, counting)
    await mm.download('test-model')
    const mm2 = new ModelManager(manifest(), dir, nullLogger, counting)
    await mm2.download('test-model')
    expect(calls).toBe(1)
  })

  it('detects a model file corrupted on disk and removes it', async () => {
    mode = 'ok'
    const dir = tmpDir()
    const mm = new ModelManager(manifest(), dir, nullLogger, localFetch)
    await mm.download('test-model')
    const file = path.join(dir, 'test.gguf')
    const buf = fs.readFileSync(file)
    buf[5] ^= 0xff
    fs.writeFileSync(file, buf)
    const mm2 = new ModelManager(manifest(), dir, nullLogger, localFetch)
    expect(await mm2.verify('test-model')).toBe(false)
    expect(fs.existsSync(file)).toBe(false)
    expect(mm2.status('test-model').error?.code).toBe('CORRUPTED_MODEL')
  })
})

describe('model manifest', () => {
  it('the shipped manifest is valid and has one default per kind', () => {
    const m = loadManifest(path.join(__dirname, '../../resources/models.json'))
    for (const kind of ['speech', 'llm']) {
      expect(m.models.filter((x) => x.kind === kind && x.default)).toHaveLength(1)
    }
  })

  it('rejects non-HuggingFace URLs, path traversal and bad checksums', () => {
    const base = manifest()
    const bad = (patch: object): boolean =>
      modelManifestSchema.safeParse({ ...base, models: [{ ...base.models[0], ...patch }] }).success
    expect(bad({ url: 'https://evil.example.com/x.gguf' })).toBe(false)
    expect(bad({ fileName: '../../etc/passwd' })).toBe(false)
    expect(bad({ sha256: 'abc' })).toBe(false)
    expect(bad({})).toBe(true)
  })

  it('rejects duplicate ids', () => {
    const base = manifest()
    expect(modelManifestSchema.safeParse({ ...base, models: [base.models[0], base.models[0]] }).success).toBe(
      false
    )
  })
})
