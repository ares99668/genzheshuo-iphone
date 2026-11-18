// Send 50 ms of mono audio at a time without playing the microphone.
class PromptMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(800);
    this.position = 0;
    this.portion = 0;
    this.total = 0;
    this.targetRate = 16000;
    this.portionPerSample = this.targetRate / sampleRate;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    const step = this.portionPerSample;
    for (const sample of channel) {
      const portion = Math.min(step,1 - this.portion);
      this.total += sample * portion;
      this.portion += portion;
      if (this.portion >= 1 - 1e-9) {
        this.block[this.position++] = this.total;
        this.portion = step - portion;
        this.total = sample * this.portion;
        if (this.position === this.block.length) {
          this.port.postMessage(this.block,[this.block.buffer]);
          this.block = new Float32Array(800);
          this.position = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("prompt-microphone",PromptMicrophone);
