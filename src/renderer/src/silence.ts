/**
 * Decides when a recording has gone quiet. Fed one RMS value per audio chunk (~256 ms).
 *
 * The noise floor is the quietest chunk of the last ~6 s (natural pauses keep it at the real
 * background level, while steady noise such as a fan raises it). A chunk counts as speech when it
 * is louder than max(MIN_SPEECH_RMS, noiseFloor * NOISE_RATIO). For the first second, before a
 * floor exists, only the absolute threshold applies. The recording should stop once `timeoutMs`
 * passes without speech, counted from the start if nothing has been said yet.
 */
const MIN_SPEECH_RMS = 0.012
const NOISE_RATIO = 2.5
const FLOOR_WINDOW_MS = 6000
const FLOOR_MIN_MS = 1000

export class SilenceDetector {
  private recent: number[] = []
  private quietMs = 0
  voiced = false
  /** Set once push() has returned true. */
  timedOut = false

  constructor(
    private readonly timeoutMs: number,
    private readonly chunkMs: number
  ) {}

  /** Returns true when the silence timeout has been reached. */
  push(rms: number): boolean {
    this.recent.push(rms)
    if (this.recent.length > Math.round(FLOOR_WINDOW_MS / this.chunkMs)) this.recent.shift()
    const haveFloor = this.recent.length * this.chunkMs >= FLOOR_MIN_MS
    const floor = haveFloor ? Math.min(...this.recent) : 0
    const speech = rms > Math.max(MIN_SPEECH_RMS, floor * NOISE_RATIO)
    if (speech) {
      this.voiced = true
      this.quietMs = 0
      return false
    }
    this.quietMs += this.chunkMs
    if (this.timeoutMs > 0 && this.quietMs >= this.timeoutMs) this.timedOut = true
    return this.timedOut
  }
}
