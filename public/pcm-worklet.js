// public/pcm-worklet.js — capture-side AudioWorklet.
// Runs inside an AudioContext created at 16000 Hz, so the browser's OWN
// pipeline resamples the microphone (no hand-rolled resampler anywhere —
// isocan-xsh.9's zeroed-PCM bug was exactly one of those).
// Emits Float32Array chunks to the main thread; nothing else lives here.

class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      // Hand the channel data over (copied — the underlying buffer is reused).
      this.port.postMessage(new Float32Array(input[0]));
    }
    return true; // keep the node alive
  }
}

registerProcessor("pcm-capture", PcmCapture);
