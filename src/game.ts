import { Sfx } from './audio';
import { crashHaptic, gemHaptic, loadValue, saveValue, tapHaptic } from './native';

// ---------------------------------------------------------------------------
// World units: the outer orbit has radius 1. Everything is scaled to the
// screen at render time, so gameplay is identical on every device size.
// ---------------------------------------------------------------------------
const LANE_R = [0.62, 1.0];
const PLAYER_R = 0.055;
const ROCK_R = 0.065;
const GEM_R = 0.05;
const SPAWN_LEAD = 2.7; // radians ahead of the player where objects appear
const LANE_EASE = 22; // higher = faster lane switch
const POINTS_PER_LEVEL = 20;
const BASE_SPEED = 1.6; // radians / second
const SPEED_PER_LEVEL = 0.22;
const MAX_SPEED = 3.7;

type State = 'menu' | 'playing' | 'paused' | 'over';
type Kind = 'rock' | 'gem';

interface Obj {
  a: number; // absolute (unwrapped) angle
  lane: 0 | 1;
  kind: Kind;
  age: number;
  spin: number;
  shape: number[]; // rock outline radii multipliers
  dead: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
}

interface FloatText {
  x: number;
  y: number;
  text: string;
  life: number;
  color: string;
}

interface Star {
  a: number;
  d: number;
  size: number;
  phase: number;
}

interface Button {
  x: number;
  y: number;
  r: number;
}

const BEST_KEY = 'orbitdash.best';
const SOUND_KEY = 'orbitdash.sound';
const FONT = '"Avenir Next", "Segoe UI", Roboto, system-ui, -apple-system, sans-serif';

export class Game {
  state: State = 'menu';
  private sfx = new Sfx();

  // viewport (CSS pixels)
  private w = 1;
  private h = 1;
  private cx = 0;
  private cy = 0;
  private scale = 1;
  private safe = { top: 0, bottom: 0, left: 0, right: 0 };

  // player
  private angle = -Math.PI / 2;
  private lane: 0 | 1 = 1;
  private radius = LANE_R[1];
  private speed = BASE_SPEED;
  private trail: { x: number; y: number }[] = [];

  // run state
  private objs: Obj[] = [];
  private nextSpawn = 0;
  score = 0;
  best = 0;
  private level = 0;
  private combo = 0;
  private newBest = false;
  private overTime = 0;
  private levelBanner = 0;

  // fx
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private stars: Star[] = [];
  private shake = 0;
  private time = 0;
  private flash = 0;

  private soundBtn: Button = { x: 0, y: 0, r: 22 };
  private pauseBtn: Button = { x: 0, y: 0, r: 22 };

  constructor() {
    for (let i = 0; i < 160; i++) {
      this.stars.push({
        a: Math.random() * Math.PI * 2,
        d: Math.sqrt(Math.random()) * 1.6,
        size: Math.random() * 1.4 + 0.3,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  async load(): Promise<void> {
    const best = await loadValue(BEST_KEY);
    this.best = best ? parseInt(best, 10) || 0 : 0;
    const sound = await loadValue(SOUND_KEY);
    this.sfx.enabled = sound !== '0';
  }

  resize(w: number, h: number, safe: { top: number; bottom: number; left: number; right: number }): void {
    this.w = w;
    this.h = h;
    this.safe = safe;
    const usableH = h - safe.top - safe.bottom;
    this.cx = w / 2;
    this.cy = safe.top + usableH * 0.54;
    this.scale = Math.min(w * 0.42, usableH * 0.3);
    const top = safe.top + 34;
    this.soundBtn = { x: w - safe.right - 34, y: top, r: 22 };
    this.pauseBtn = { x: safe.left + 34, y: top, r: 22 };
  }

  // ------------------------------------------------------------------ input

  pointerDown(x: number, y: number): void {
    this.sfx.unlock();

    if (this.hit(this.soundBtn, x, y) && this.state !== 'playing') {
      this.sfx.enabled = !this.sfx.enabled;
      void saveValue(SOUND_KEY, this.sfx.enabled ? '1' : '0');
      tapHaptic();
      return;
    }
    if (this.state === 'playing' && this.hit(this.pauseBtn, x, y)) {
      this.pause();
      return;
    }
    this.action();
  }

  /** The single game action: start / switch lane / resume / retry. */
  action(): void {
    this.sfx.unlock();
    switch (this.state) {
      case 'menu':
        this.start();
        break;
      case 'playing':
        this.switchLane();
        break;
      case 'paused':
        this.state = 'playing';
        break;
      case 'over':
        if (this.overTime > 0.6) this.start();
        break;
    }
  }

  pause(): void {
    if (this.state === 'playing') this.state = 'paused';
  }

  /** Android back button. Returns true if handled (false lets the app exit). */
  back(): boolean {
    if (this.state === 'playing') {
      this.pause();
      return true;
    }
    if (this.state === 'paused' || this.state === 'over') {
      this.state = 'menu';
      this.reset();
      return true;
    }
    return false;
  }

  onAppPause(): void {
    this.pause();
    this.sfx.suspend();
  }

  onAppResume(): void {
    // Audio resumes on the next tap (unlock) to respect autoplay policies.
  }

  private hit(b: Button, x: number, y: number): boolean {
    const dx = x - b.x;
    const dy = y - b.y;
    return dx * dx + dy * dy <= (b.r + 10) * (b.r + 10);
  }

  // ------------------------------------------------------------------ flow

  private reset(): void {
    this.objs = [];
    this.particles = [];
    this.texts = [];
    this.trail = [];
    this.angle = -Math.PI / 2;
    this.lane = 1;
    this.radius = LANE_R[1];
    this.speed = BASE_SPEED;
    this.score = 0;
    this.level = 0;
    this.combo = 0;
    this.newBest = false;
    this.levelBanner = 0;
    this.nextSpawn = this.angle + SPAWN_LEAD;
  }

  private start(): void {
    this.reset();
    this.state = 'playing';
    tapHaptic();
  }

  private switchLane(): void {
    this.lane = this.lane === 1 ? 0 : 1;
    this.sfx.switchLane(this.lane === 1);
    tapHaptic();
  }

  private gameOver(): void {
    this.state = 'over';
    this.overTime = 0;
    this.shake = 1;
    this.flash = 1;
    this.sfx.crash();
    crashHaptic();
    const p = this.playerPos();
    this.burst(p.x, p.y, 46, ['#ffffff', '#7df9ff', '#ff6b6b', '#ffd166'], 1.6);
    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
      void saveValue(BEST_KEY, String(this.best));
    }
  }

  // ------------------------------------------------------------------ update

  update(dt: number): void {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.flash = Math.max(0, this.flash - dt * 3);
    this.levelBanner = Math.max(0, this.levelBanner - dt);

    if (this.state === 'paused') return;

    if (this.state === 'menu') {
      // Idle demo orbit on the title screen.
      this.angle += dt * 1.1;
      this.radius += (LANE_R[1] - this.radius) * (1 - Math.exp(-dt * LANE_EASE));
      this.pushTrail();
    }

    if (this.state === 'playing') this.updatePlaying(dt);
    if (this.state === 'over') this.overTime += dt;

    this.updateFx(dt);
  }

  private updatePlaying(dt: number): void {
    const targetSpeed = Math.min(MAX_SPEED, BASE_SPEED + this.level * SPEED_PER_LEVEL);
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-dt * 2));
    this.angle += this.speed * dt;
    this.radius += (LANE_R[this.lane] - this.radius) * (1 - Math.exp(-dt * LANE_EASE));
    this.pushTrail();

    while (this.angle + SPAWN_LEAD >= this.nextSpawn) this.spawnPattern();

    const p = this.playerPos();
    for (const o of this.objs) {
      if (o.dead) continue;
      o.age += dt;
      o.spin += dt * (o.kind === 'gem' ? 3 : 0.8);
      const op = this.objPos(o);
      const rr = (o.kind === 'rock' ? ROCK_R : GEM_R) + PLAYER_R;
      const dx = p.x - op.x;
      const dy = p.y - op.y;

      if (dx * dx + dy * dy < rr * rr * (o.kind === 'rock' ? 0.8 : 1.4)) {
        if (o.kind === 'rock') {
          this.gameOver();
          return;
        }
        o.dead = true;
        this.combo++;
        this.addScore(3, op.x, op.y, '#ffd166');
        this.burst(op.x, op.y, 14, ['#ffd166', '#fff3b0'], 0.8);
        this.sfx.gem(this.combo);
        gemHaptic();
        continue;
      }

      // Passed behind the player.
      if (this.angle - o.a > 0.35) {
        o.dead = true;
        if (o.kind === 'rock') {
          this.addScore(1);
          this.sfx.pass();
        } else {
          this.combo = 0;
        }
      }
    }
    this.objs = this.objs.filter((o) => !o.dead);
  }

  private addScore(n: number, x?: number, y?: number, color = '#ffffff'): void {
    this.score += n;
    if (x !== undefined && y !== undefined) this.texts.push({ x, y, text: `+${n}`, life: 1, color });
    const lvl = Math.floor(this.score / POINTS_PER_LEVEL);
    if (lvl > this.level) {
      this.level = lvl;
      if (BASE_SPEED + lvl * SPEED_PER_LEVEL <= MAX_SPEED + SPEED_PER_LEVEL) {
        this.levelBanner = 1.6;
        this.sfx.levelUp();
      }
    }
  }

  /** Minimum angular gap so a lane switch between two obstacles is always possible. */
  private minGap(): number {
    return 0.45 + this.speed * 0.28;
  }

  private spawnPattern(): void {
    const a = this.nextSpawn;
    const lane = (Math.random() < 0.5 ? 0 : 1) as 0 | 1;
    const other = (1 - lane) as 0 | 1;
    const ease = Math.max(0, 0.6 - this.score * 0.025); // gentler start
    let gap = this.minGap() + ease + Math.random() * 0.35;
    const r = Math.random();

    if (this.score >= 12 && r < 0.3) {
      // Zig-zag: rocks alternate lanes, forcing quick double switches.
      const n = this.score >= 40 ? 3 : 2;
      const sep = this.minGap() + 0.05;
      for (let i = 0; i < n; i++) this.addObj(a + i * sep, (i % 2 === 0 ? lane : other) as 0 | 1, 'rock');
      if (Math.random() < 0.5) this.addObj(a + sep * 0.5, other, 'gem');
      gap += sep * (n - 1);
    } else if (r < 0.42) {
      // Gem arc: a short line of gems in one lane.
      const n = 3;
      for (let i = 0; i < n; i++) this.addObj(a + i * 0.22, lane, 'gem');
      gap += 0.44;
    } else {
      // Single rock, sometimes with a gem in the safe lane.
      this.addObj(a, lane, 'rock');
      if (Math.random() < 0.35) this.addObj(a, other, 'gem');
    }
    this.nextSpawn = a + gap;
  }

  private addObj(a: number, lane: 0 | 1, kind: Kind): void {
    const shape: number[] = [];
    for (let i = 0; i < 8; i++) shape.push(0.78 + Math.random() * 0.32);
    this.objs.push({ a, lane, kind, age: 0, spin: Math.random() * 6, shape, dead: false });
  }

  private updateFx(dt: number): void {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.pow(0.08, dt);
      p.vy *= Math.pow(0.08, dt);
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const t of this.texts) {
      t.life -= dt * 1.2;
      t.y -= dt * 0.25;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
  }

  private burst(x: number, y: number, n: number, colors: string[], power: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (0.3 + Math.random()) * power;
      const max = 0.4 + Math.random() * 0.6;
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: max,
        max,
        size: 0.008 + Math.random() * 0.014,
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
  }

  private pushTrail(): void {
    this.trail.push(this.playerPos());
    if (this.trail.length > 16) this.trail.shift();
  }

  private playerPos(): { x: number; y: number } {
    return { x: Math.cos(this.angle) * this.radius, y: Math.sin(this.angle) * this.radius };
  }

  private objPos(o: Obj): { x: number; y: number } {
    const r = LANE_R[o.lane];
    return { x: Math.cos(o.a) * r, y: Math.sin(o.a) * r };
  }

  /** Snapshot used by the automated playtest bot (dev builds only). */
  debugState() {
    return {
      angle: this.angle,
      lane: this.lane,
      speed: this.speed,
      objs: this.objs.map((o) => ({ a: o.a, lane: o.lane, kind: o.kind })),
    };
  }

  // ------------------------------------------------------------------ render

  render(ctx: CanvasRenderingContext2D): void {
    const { w, h } = this;
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0b0d1f');
    bg.addColorStop(1, '#1a1040');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    if (this.shake > 0) {
      const s = this.shake * this.shake * 14;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    ctx.translate(this.cx, this.cy);
    const S = this.scale;

    this.drawStars(ctx, S);
    this.drawPlanet(ctx, S);
    this.drawLanes(ctx, S);
    for (const o of this.objs) this.drawObj(ctx, o, S);
    if (this.state !== 'over') this.drawPlayer(ctx, S);
    this.drawParticles(ctx, S);
    this.drawTexts(ctx, S);
    ctx.restore();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.35})`;
      ctx.fillRect(0, 0, w, h);
    }

    this.drawHud(ctx);
  }

  private drawStars(ctx: CanvasRenderingContext2D, S: number): void {
    const R = Math.max(this.w, this.h) / S;
    const rot = this.time * 0.02;
    for (const s of this.stars) {
      const a = s.a + rot;
      const d = s.d * R * 0.75;
      const tw = 0.5 + 0.5 * Math.sin(this.time * 2 + s.phase);
      ctx.globalAlpha = 0.25 + tw * 0.6;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.cos(a) * d * S, Math.sin(a) * d * S, s.size, s.size);
    }
    ctx.globalAlpha = 1;
  }

  private drawPlanet(ctx: CanvasRenderingContext2D, S: number): void {
    const r = 0.3 * S;
    const glow = ctx.createRadialGradient(0, 0, r * 0.8, 0, 0, r * 2.2);
    glow.addColorStop(0, 'rgba(124, 92, 255, 0.35)');
    glow.addColorStop(1, 'rgba(124, 92, 255, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    const body = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, 0, 0, r);
    body.addColorStop(0, '#b69cff');
    body.addColorStop(0.55, '#6a4bd8');
    body.addColorStop(1, '#2a1a6e');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Score displayed inside the planet while playing.
    if (this.state === 'playing' || this.state === 'paused') {
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.font = `800 ${Math.round(r * 0.75)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(this.score), 0, r * 0.04);
    }
  }

  private drawLanes(ctx: CanvasRenderingContext2D, S: number): void {
    ctx.lineWidth = Math.max(1.5, S * 0.008);
    ctx.setLineDash([S * 0.03, S * 0.045]);
    LANE_R.forEach((lr, i) => {
      const active = this.state === 'playing' && this.lane === i;
      ctx.strokeStyle = active ? 'rgba(125, 249, 255, 0.45)' : 'rgba(255, 255, 255, 0.14)';
      ctx.lineDashOffset = -this.time * S * 0.08 * (i === 0 ? 1 : -1);
      ctx.beginPath();
      ctx.arc(0, 0, lr * S, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  private drawObj(ctx: CanvasRenderingContext2D, o: Obj, S: number): void {
    const p = this.objPos(o);
    const appear = Math.min(1, o.age / 0.25);
    const k = appear * (2 - appear); // ease-out
    ctx.save();
    ctx.translate(p.x * S, p.y * S);
    ctx.rotate(o.spin);
    ctx.scale(k, k);
    if (o.kind === 'rock') {
      const r = ROCK_R * S;
      ctx.shadowColor = 'rgba(255, 90, 90, 0.8)';
      ctx.shadowBlur = r * 0.8;
      ctx.fillStyle = '#ff5d5d';
      ctx.beginPath();
      o.shape.forEach((m, i) => {
        const a = (i / o.shape.length) * Math.PI * 2;
        const x = Math.cos(a) * r * m;
        const y = Math.sin(a) * r * m;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(120, 20, 40, 0.55)';
      ctx.beginPath();
      ctx.arc(r * 0.2, -r * 0.15, r * 0.22, 0, Math.PI * 2);
      ctx.arc(-r * 0.3, r * 0.25, r * 0.14, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const r = GEM_R * S;
      const pulse = 1 + Math.sin(this.time * 6 + o.a) * 0.08;
      ctx.scale(pulse, pulse);
      ctx.shadowColor = 'rgba(255, 209, 102, 0.9)';
      ctx.shadowBlur = r;
      ctx.fillStyle = '#ffd166';
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.75, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.75, 0);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff3b0';
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.55);
      ctx.lineTo(r * 0.3, 0);
      ctx.lineTo(0, r * 0.1);
      ctx.lineTo(-r * 0.3, 0);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, S: number): void {
    const n = this.trail.length;
    for (let i = 0; i < n; i++) {
      const t = this.trail[i];
      const f = i / n;
      ctx.globalAlpha = f * 0.5;
      ctx.fillStyle = '#7df9ff';
      ctx.beginPath();
      ctx.arc(t.x * S, t.y * S, PLAYER_R * S * (0.3 + f * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const p = this.playerPos();
    ctx.shadowColor = '#7df9ff';
    ctx.shadowBlur = PLAYER_R * S * 1.2;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x * S, p.y * S, PLAYER_R * S, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  private drawParticles(ctx: CanvasRenderingContext2D, S: number): void {
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x * S, p.y * S, p.size * S, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawTexts(ctx: CanvasRenderingContext2D, S: number): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(S * 0.09)}px ${FONT}`;
    for (const t of this.texts) {
      ctx.globalAlpha = Math.max(0, t.life);
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x * S, t.y * S - S * 0.08);
    }
    ctx.globalAlpha = 1;
  }

  private text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, weight = 800): void {
    ctx.font = `${weight} ${Math.round(size)}px ${FONT}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }

  private drawHud(ctx: CanvasRenderingContext2D): void {
    const { w, cx } = this;
    const base = Math.min(w, 520);
    const topY = this.safe.top;
    const bottomY = this.h - this.safe.bottom;

    if (this.state !== 'playing') this.drawSoundButton(ctx);

    if (this.state === 'menu') {
      const titleY = topY + (this.cy - this.scale - topY) * 0.5;
      this.text(ctx, 'ORBIT DASH', cx, titleY, base * 0.13, '#ffffff', 900);
      this.text(ctx, 'Tap to switch orbits · dodge rocks · grab gems', cx, titleY + base * 0.09, base * 0.036, 'rgba(255,255,255,0.65)', 600);
      const pulse = 0.55 + 0.45 * Math.sin(this.time * 4);
      const below = this.cy + this.scale + (bottomY - this.cy - this.scale) * 0.4;
      this.text(ctx, 'TAP TO PLAY', cx, below, base * 0.065, `rgba(255,255,255,${pulse})`, 800);
      if (this.best > 0) this.text(ctx, `BEST ${this.best}`, cx, below + base * 0.1, base * 0.05, '#ffd166', 800);
    }

    if (this.state === 'playing' || this.state === 'paused') {
      this.drawPauseButton(ctx);
      this.text(ctx, `BEST ${Math.max(this.best, this.score)}`, cx, topY + 34, base * 0.04, 'rgba(255,255,255,0.55)', 700);
      if (this.levelBanner > 0) {
        const a = Math.min(1, this.levelBanner * 2);
        this.text(ctx, 'SPEED UP!', cx, this.cy - this.scale - base * 0.09, base * 0.07, `rgba(125,249,255,${a})`, 900);
      }
    }

    if (this.state === 'paused') {
      ctx.fillStyle = 'rgba(8, 8, 24, 0.65)';
      ctx.fillRect(0, 0, w, this.h);
      this.text(ctx, 'PAUSED', cx, this.cy - base * 0.06, base * 0.12, '#ffffff', 900);
      this.text(ctx, 'Tap to resume', cx, this.cy + base * 0.06, base * 0.045, 'rgba(255,255,255,0.75)', 600);
    }

    if (this.state === 'over') {
      const a = Math.min(1, this.overTime * 3);
      ctx.fillStyle = `rgba(8, 8, 24, ${0.6 * a})`;
      ctx.fillRect(0, 0, w, this.h);
      ctx.globalAlpha = a;
      this.text(ctx, 'GAME OVER', cx, this.cy - base * 0.26, base * 0.1, '#ff6b6b', 900);
      this.text(ctx, String(this.score), cx, this.cy - base * 0.05, base * 0.22, '#ffffff', 900);
      if (this.newBest) {
        const p = 1 + Math.sin(this.time * 6) * 0.05;
        this.text(ctx, 'NEW BEST!', cx, this.cy + base * 0.12, base * 0.06 * p, '#ffd166', 900);
      } else {
        this.text(ctx, `BEST ${this.best}`, cx, this.cy + base * 0.12, base * 0.05, '#ffd166', 800);
      }
      if (this.overTime > 0.6) {
        const pulse = 0.55 + 0.45 * Math.sin(this.time * 4);
        this.text(ctx, 'TAP TO RETRY', cx, this.cy + base * 0.3, base * 0.055, `rgba(255,255,255,${pulse})`, 800);
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawSoundButton(ctx: CanvasRenderingContext2D): void {
    const { x, y, r } = this.soundBtn;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    const s = r * 0.42;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(x - s * 1.1, y - s * 0.45);
    ctx.lineTo(x - s * 0.45, y - s * 0.45);
    ctx.lineTo(x + s * 0.25, y - s);
    ctx.lineTo(x + s * 0.25, y + s);
    ctx.lineTo(x - s * 0.45, y + s * 0.45);
    ctx.lineTo(x - s * 1.1, y + s * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (this.sfx.enabled) {
      ctx.arc(x + s * 0.4, y, s * 0.55, -0.9, 0.9);
      ctx.moveTo(x + s * 0.4 + Math.cos(-0.9) * s, y + Math.sin(-0.9) * s);
      ctx.arc(x + s * 0.4, y, s, -0.9, 0.9);
    } else {
      ctx.moveTo(x + s * 0.6, y - s * 0.45);
      ctx.lineTo(x + s * 1.3, y + s * 0.45);
      ctx.moveTo(x + s * 1.3, y - s * 0.45);
      ctx.lineTo(x + s * 0.6, y + s * 0.45);
    }
    ctx.stroke();
  }

  private drawPauseButton(ctx: CanvasRenderingContext2D): void {
    const { x, y, r } = this.pauseBtn;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    const bw = r * 0.22;
    const bh = r * 0.8;
    ctx.fillRect(x - bw * 1.6, y - bh / 2, bw, bh);
    ctx.fillRect(x + bw * 0.6, y - bh / 2, bw, bh);
  }
}
