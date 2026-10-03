import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TogglePipe, shortcutCommand } from '../../src/main/toggle-pipe'
import { nullLogger } from '../../src/main/logger'

const argv = (cmd: string): string[] =>
  JSON.parse(
    execFileSync('python3', [
      '-c',
      'import shlex,sys,json; print(json.dumps(shlex.split(sys.argv[1])))',
      cmd
    ]).toString()
  )

describe('TogglePipe + shortcut command', () => {
  it('delivers one toggle per shortcut press, in ~milliseconds', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echonote-pipe-test-'))
    const file = path.join(dir, 'toggle')
    let toggles = 0
    const pipe = new TogglePipe(file, nullLogger, () => toggles++)
    expect(pipe.start()).toBe(true)
    expect(fs.statSync(file).isFIFO()).toBe(true)
    const a = argv(shortcutCommand(file, ['/bin/false']))
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now()
      expect(spawnSync(a[0], a.slice(1)).status).toBe(0)
      expect(Date.now() - t0).toBeLessThan(500)
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(toggles).toBe(3)
    pipe.stop()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('falls back to launching the app when nothing is listening', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echonote-pipe-test-'))
    const marker = path.join(dir, 'launched')
    // "App" = a shell that records its arguments.
    const a = argv(shortcutCommand(path.join(dir, 'missing'), ['sh', '-c', `echo "$@" > ${marker}`, 'app']))
    expect(spawnSync(a[0], a.slice(1)).status).toBe(0)
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe('--toggle')
  })
})
