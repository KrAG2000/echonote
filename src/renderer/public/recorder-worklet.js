// Collects mono Float32 samples from the microphone and posts them to the page in batches.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(4096)
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i]
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf)
          this.buf = new Float32Array(4096)
          this.n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('echonote-capture', CaptureProcessor)
