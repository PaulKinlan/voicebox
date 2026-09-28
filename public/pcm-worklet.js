// public/pcm-worklet.js — capture-side AudioWorklet.
// Runs inside an AudioContext created at 16000 Hz, so the browser's OWN
// pipeline resamples the microphone (no hand-rolled resampler anywhere —
// isocan-xsh.9's zeroed-PCM bug was exactly one of those).
// Emits Float32Array chunks to the main thread; nothing else lives here.

const BATCH_SAMPLES = 512;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(BATCH_SAMPLES);
    this._offset = 0;
    this.port.onmessage = (event) => {
      if (event?.data === "flush" && this._offset > 0) {
        this.port.postMessage(this._buffer.slice(0, this._offset));
        this._offset = 0;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length > 0) {
      let read = 0;
      while (read < channel.length) {
        const space = BATCH_SAMPLES - this._offset;
        const take = Math.min(space, channel.length - read);
        this._buffer.set(channel.subarray(read, read + take), this._offset);
        this._offset += take;
        read += take;
        if (this._offset === BATCH_SAMPLES) {
          // Hand the accumulated 512-sample batch over (copied — the underlying buffer is reused).
          this.port.postMessage(new Float32Array(this._buffer));
          this._offset = 0;
        }
      }
    }
    return true; // keep the node alive
  }
}

registerProcessor("pcm-capture", PcmCapture);
