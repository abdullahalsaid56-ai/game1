// All sound effects are synthesized with the Web Audio API, so the game ships
// with no audio assets and no licensing concerns.

type Ctx = AudioContext;

export class Sfx {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  enabled = true;

  /** Must be called from a user gesture (iOS requires this to unlock audio). */
  unlock(): void {
    if (!this.ctx) {
      const AC: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  private tone(freq: number, endFreq: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  switchLane(outer: boolean): void {
    this.tone(outer ? 520 : 400, outer ? 720 : 300, 0.08, 'triangle', 0.25);
  }

  gem(combo: number): void {
    const base = 660 * Math.pow(2, Math.min(combo, 12) / 12);
    this.tone(base, base * 1.5, 0.12, 'sine', 0.3);
    this.tone(base * 1.5, base * 2, 0.15, 'sine', 0.2, 0.06);
  }

  pass(): void {
    this.tone(220, 260, 0.05, 'square', 0.04);
  }

  levelUp(): void {
    [0, 4, 7, 12].forEach((n, i) => this.tone(440 * Math.pow(2, n / 12), 440 * Math.pow(2, n / 12), 0.12, 'triangle', 0.2, i * 0.07));
  }

  powerUp(): void {
    [0, 7, 12, 19].forEach((n, i) => this.tone(523 * Math.pow(2, n / 12), 523 * Math.pow(2, (n + 2) / 12), 0.1, 'sine', 0.22, i * 0.05));
  }

  shieldBreak(): void {
    this.tone(900, 200, 0.25, 'triangle', 0.3);
    this.tone(600, 120, 0.3, 'square', 0.08, 0.03);
  }

  closeCall(): void {
    this.tone(880, 1320, 0.07, 'triangle', 0.18);
  }

  buy(): void {
    this.tone(660, 990, 0.08, 'square', 0.12);
    this.tone(990, 1480, 0.12, 'sine', 0.2, 0.07);
  }

  mission(): void {
    [0, 4, 7, 12, 16].forEach((n, i) => this.tone(587 * Math.pow(2, n / 12), 587 * Math.pow(2, n / 12), 0.14, 'triangle', 0.2, i * 0.08));
  }

  denied(): void {
    this.tone(200, 140, 0.15, 'square', 0.12);
  }

  click(): void {
    this.tone(700, 800, 0.04, 'triangle', 0.15);
  }

  crash(): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const len = Math.floor(this.ctx.sampleRate * 0.5);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2000, t);
    filter.frequency.exponentialRampToValueAtTime(100, t + 0.5);
    const g = this.ctx.createGain();
    g.gain.value = 0.7;
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    this.tone(180, 40, 0.4, 'sawtooth', 0.25);
  }
}
