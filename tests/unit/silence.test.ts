import { describe, expect, it } from 'vitest'
import { SilenceDetector } from '../../src/renderer/src/silence'

const feed = (d: SilenceDetector, rms: number, chunks: number): boolean => {
  let stop = false
  for (let i = 0; i < chunks; i++) stop = d.push(rms) || stop
  return stop
}

describe('SilenceDetector', () => {
  it('stops after 5 s of silence when nothing was said, and reports no speech', () => {
    const d = new SilenceDetector(5000, 256)
    expect(feed(d, 0.002, 19)).toBe(false) // 4.86 s
    expect(d.push(0.002)).toBe(true) // 5.12 s
    expect(d.voiced).toBe(false)
  })

  it('speech resets the timer and marks the recording as voiced', () => {
    const d = new SilenceDetector(5000, 256)
    feed(d, 0.002, 15)
    expect(feed(d, 0.08, 4)).toBe(false)
    expect(d.voiced).toBe(true)
    expect(feed(d, 0.002, 19)).toBe(false)
    expect(d.push(0.002)).toBe(true)
  })

  it('steady background noise is not mistaken for speech', () => {
    const d = new SilenceDetector(5000, 256)
    expect(feed(d, 0.02, 30)).toBe(true) // constant fan noise above the absolute floor
  })

  it('a long monologue with natural pauses keeps recording', () => {
    const d = new SilenceDetector(5000, 256)
    for (let i = 0; i < 80; i++) expect(d.push(i % 6 === 5 ? 0.003 : 0.06 + (i % 3) * 0.02)).toBe(false)
  })

  it('a timeout of 0 never stops but still detects speech', () => {
    const d = new SilenceDetector(0, 256)
    expect(feed(d, 0.0, 100)).toBe(false)
    d.push(0.1)
    expect(d.voiced).toBe(true)
  })
})
