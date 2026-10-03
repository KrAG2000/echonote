/**
 * Downloads and verifies models into a directory using the app's own ModelManager (same
 * resumable download + SHA-256 verification as first-run setup). Useful for development,
 * integration tests and pre-seeding a machine.
 *
 *   npm run models:prepare -- [--dir <models dir>] [model-id ...]
 *
 * Default dir: ~/.config/EchoNote/models. Default models: the manifest defaults.
 */
import os from 'node:os'
import path from 'node:path'
import { loadManifest, ModelManager } from '../src/main/services/model-manager'
import { createLogger } from '../src/main/logger'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const dirIdx = args.indexOf('--dir')
  const dir =
    dirIdx >= 0 ? args.splice(dirIdx, 2)[1] : path.join(os.homedir(), '.config', 'EchoNote', 'models')
  const manifest = loadManifest(path.join(process.cwd(), 'resources', 'models.json'))
  const ids = args.length ? args : manifest.models.filter((m) => m.default).map((m) => m.id)
  const mm = new ModelManager(manifest, dir, createLogger(null))
  let last = 0
  mm.on('progress', (id: string) => {
    const s = mm.status(id)
    if (Date.now() - last > 2000 || s.verifying) {
      last = Date.now()
      process.stdout.write(
        `  ${id}: ${s.verifying ? 'verifying' : `${Math.round(s.downloadedBytes / 1048576)} / ${Math.round(s.sizeBytes / 1048576)} MB`}\n`
      )
    }
  })
  for (const id of ids) {
    const t0 = Date.now()
    console.log(`==> ${id}`)
    await mm.download(id)
    console.log(`    ok (${((Date.now() - t0) / 1000).toFixed(1)} s) -> ${mm.pathFor(id)}`)
  }
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`)
  process.exit(1)
})
