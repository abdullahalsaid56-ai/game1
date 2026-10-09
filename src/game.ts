import { Sfx } from './audio';
import {
  POWERS,
  POWER_KINDS,
  SKINS,
  THEMES,
  describeMission,
  newMission,
  skinById,
  updateMissions,
  type PowerKind,
  type RunStats,
  type Theme,
} from './content';
import { money } from './monetize';
import { crashHaptic, gemHaptic, tapHaptic } from './native';
import { defaultProfile, loadProfile, saveProfile, type MissionState, type Profile } from './profile';
import { FONT, button, gemAmount, gemIcon, hit, powerIcon, progressBar, roundRect, text, timerRing, trailColor, type Rect } from './ui';

// ---------------------------------------------------------------------------
// World units: the outer orbit has radius 1. Everything is scaled to the
// screen at render time, so gameplay is identical on every device size.
// ---------------------------------------------------------------------------
const LANE_R = [0.62, 1.0];
const PLAYER_R = 0.055;
const ROCK_R = 0.065;
const GEM_R = 0.05;
const POWER_R = 0.06;
const COMET_R = 0.06;
const SPAWN_LEAD = 2.7; // radians ahead of the player where objects appear
const LANE_EASE = 22; // higher = faster lane switch
const POINTS_PER_LEVEL = 20;
const BASE_SPEED = 1.6; // radians / second
const SPEED_PER_LEVEL = 0.22;
const MAX_SPEED = 3.7;
const COMET_SPEED = 0.8; // radians / second, towards the player
const SLOW_FACTOR = 0.55;
const GEMS_PER_MULT = 4;
const MAX_MULT = 5;
const CLOSE_CALL = 0.45; // radians: switching away this close to a hazard counts as a close call

type State = 'menu' | 'shop' | 'missions' | 'playing' | 'paused' | 'over';
type Kind = 'rock' | 'gem' | 'comet' | 'power';

interface Obj {
  a: number; // absolute (unwrapped) angle
  lane: 0 | 1;
  kind: Kind;
  power: PowerKind;
  vel: number; // angular velocity (comets move towards the player)
  target: number; // comets: where they will cross the player's path
  age: number;
  spin: number;
  shape: number[]; // rock outline radii multipliers
  dead: boolean;
  crossed: boolean; // has passed the player's angle
  fly: number; // >= 0 while being pulled in by the magnet
  fx: number;
  fy: number;
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
  size: number;
}

interface Star {
  a: number;
  d: number;
  size: number;
  phase: number;
}

interface Btn extends Rect {
  id: string;
}

const isHazard = (o: Obj) => o.kind === 'rock' || o.kind === 'comet';

function emptyStats(): RunStats {
  return { score: 0, gems: 0, dodges: 0, powerups: 0, shieldSaves: 0, maxMultiplier: 1, comets: 0 };
}

export class Game {
  state: State = 'menu';
  private sfx = new Sfx();
  private profile: Profile = defaultProfile();

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
  private shield = false;
  private invuln = 0;
  private timers = { magnet: 0, slow: 0, double: 0 };

  // run state
  private objs: Obj[] = [];
  private nextSpawn = 0;
  score = 0;
  private level = 0;
  private progress = 0; // un-multiplied points: drives zones and speed
  private streak = 0;
  private mult = 1;
  private gameTime = 0; // slowed by slow-mo
  private lastSwitchAngle = -99;
  private lastSwitchFrom: 0 | 1 = 1;
  private switches = 0;
  private stats: RunStats = emptyStats();
  private banked: number[] = [];
  private newBest = false;
  private overTime = 0;
  private zone = 0;
  private prevZone = 0;
  private zoneFade = 1;
  private banner = { title: '', sub: '', life: 0 };
  private toast = { text: '', color: '#fff', life: 0 };

  // shop
  private shopShake = { id: '', t: 0 };

  // ads
  private busy = false; // an ad is showing (or loading) - ignore input
  private continueOffer = 0; // seconds left on the "continue?" offer
  private usedContinue = false;
  private reviving = false; // paused screen shown after a revive
  private doubledGems = false;
  private finalized = false; // the current run has been recorded
  private simAd: { kind: string; t: number; done: () => void } | null = null;

  // fx
  private particles: Particle[] = [];
  private texts: FloatText[] = [];
  private stars: Star[] = [];
  private shake = 0;
  private time = 0;
  private flash = 0;

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
    this.profile = await loadProfile();
    this.sfx.enabled = this.profile.sound;
    this.replaceDoneMissions();

    money.onAdOpen = () => {
      this.busy = true;
      this.sfx.suspend();
    };
    money.onAdClose = () => {
      this.busy = false;
    };
    money.onAdsRemoved = () => {
      this.profile.adsRemoved = true;
      saveProfile(this.profile);
    };
    money.onSimulatedAd = (kind, done) => {
      this.simAd = { kind, t: 0, done };
    };
    void money.init(this.profile.adsRemoved);
  }

  private get best(): number {
    return this.profile.best;
  }

  resize(w: number, h: number, safe: { top: number; bottom: number; left: number; right: number }): void {
    this.w = w;
    this.h = h;
    this.safe = safe;
    const usableH = h - safe.top - safe.bottom;
    this.cx = w / 2;
    this.cy = safe.top + usableH * 0.5;
    this.scale = Math.min(w * 0.42, usableH * 0.28);
  }

  // ------------------------------------------------------------------ layout

  private get base(): number {
    return Math.min(this.w, 520);
  }

  private buttons(): Btn[] {
    const { w, base } = this;
    const top = this.safe.top + 14;
    const bottom = this.h - this.safe.bottom;
    const icon = (id: string, x: number): Btn => ({ id, x: x - 22, y: top, w: 44, h: 44 });
    const bw = Math.min(base * 0.42, 200);
    const bh = Math.min(56, base * 0.14);
    const cx = this.cx;

    switch (this.state) {
      case 'menu':
        return [
          icon('sound', w - this.safe.right - 36),
          { id: 'shop', x: cx - bw - 8, y: bottom - bh - 28, w: bw, h: bh },
          { id: 'missions', x: cx + 8, y: bottom - bh - 28, w: bw, h: bh },
        ];
      case 'playing':
        return [icon('pause', this.safe.left + 36)];
      case 'paused':
        return [
          { id: 'resume', x: cx - bw / 2, y: this.cy + base * 0.08, w: bw, h: bh },
          ...(this.reviving ? [] : [{ id: 'home', x: cx - bw / 2, y: this.cy + base * 0.08 + bh + 14, w: bw, h: bh }]),
        ];
      case 'over': {
        if (this.busy) return [];
        if (this.continueOffer > 0) {
          const y = this.cy + base * 0.16;
          return [
            { id: 'continue', x: cx - bw * 0.65, y, w: bw * 1.3, h: bh },
            { id: 'decline', x: cx - bw / 2, y: y + bh + 14, w: bw, h: bh * 0.8 },
          ];
        }
        if (this.overTime < 0.6) return [];
        const list: Btn[] = [
          { id: 'retry', x: cx - bw - 8, y: bottom - bh - 28, w: bw, h: bh },
          { id: 'home', x: cx + 8, y: bottom - bh - 28, w: bw, h: bh },
        ];
        if (this.canDoubleGems) list.push({ id: 'double', x: cx - bw * 0.9, y: bottom - bh * 1.85 - 44, w: bw * 1.8, h: bh * 0.85 });
        return list;
      }
      case 'shop': {
        const extra: Btn[] = [];
        if (money.storeAvailable) {
          const width = Math.min(this.w - 32, 460);
          const left = (this.w - width) / 2;
          const y = this.safe.top + 72;
          extra.push({ id: 'removeAds', x: left, y, w: width, h: 52 });
          extra.push({ id: 'restore', x: left, y: y + 58, w: width / 2 - 6, h: 30 });
          if (money.showPrivacyOptions) extra.push({ id: 'privacy', x: left + width / 2 + 6, y: y + 58, w: width / 2 - 6, h: 30 });
        }
        return [icon('back', this.safe.left + 36), ...extra, ...this.shopCards()];
      }
      case 'missions':
        return [icon('back', this.safe.left + 36)];
    }
  }

  private shopCards(): Btn[] {
    const gap = 12;
    const cols = 2;
    const width = Math.min(this.w - 32, 460);
    const cw = (width - gap * (cols - 1)) / cols;
    const top = this.safe.top + (money.storeAvailable ? 180 : 110);
    const avail = this.h - this.safe.bottom - 24 - top;
    const ch = Math.min(cw * 0.95, (avail - gap * 2) / 3);
    const left = (this.w - width) / 2;
    return SKINS.map((s, i) => ({
      id: `skin:${s.id}`,
      x: left + (i % cols) * (cw + gap),
      y: top + Math.floor(i / cols) * (ch + gap),
      w: cw,
      h: ch,
    }));
  }

  // ------------------------------------------------------------------ input

  pointerDown(x: number, y: number): void {
    this.sfx.unlock();
    if (this.busy || this.simAd) return;
    const b = this.buttons().find((btn) => hit(btn, x, y));
    if (b) {
      this.press(b.id);
      return;
    }
    if (this.state === 'menu' || this.state === 'playing' || this.state === 'paused') this.action();
  }

  private press(id: string): void {
    if (['shop', 'missions', 'back', 'home'].includes(id)) this.toast.life = 0;
    if (id !== 'retry' && id !== 'resume') {
      this.sfx.click();
      tapHaptic();
    }
    if (id.startsWith('skin:')) {
      this.selectSkin(id.slice(5));
      return;
    }
    switch (id) {
      case 'sound':
        this.profile.sound = this.sfx.enabled = !this.sfx.enabled;
        saveProfile(this.profile);
        break;
      case 'pause':
        this.pause();
        break;
      case 'resume':
        this.action();
        break;
      case 'retry':
        void this.leaveOver('retry');
        break;
      case 'home':
        if (this.state === 'over') {
          void this.leaveOver('home');
        } else {
          // Quitting mid-run still counts the run (gems, best score).
          if (this.state === 'paused') this.finalizeRun();
          this.goHome();
        }
        break;
      case 'continue':
        void this.watchToContinue();
        break;
      case 'decline':
        this.finalizeRun();
        break;
      case 'double':
        void this.watchToDoubleGems();
        break;
      case 'removeAds':
        if (money.canBuy) void this.buyRemoveAds();
        break;
      case 'restore':
        void this.restorePurchases();
        break;
      case 'privacy':
        void money.openPrivacyOptions();
        break;
      case 'shop':
        this.state = 'shop';
        break;
      case 'missions':
        this.state = 'missions';
        break;
      case 'back':
        this.state = 'menu';
        break;
    }
  }

  /** The single game action: start / switch lane / resume / retry. */
  action(): void {
    this.sfx.unlock();
    if (this.busy || this.simAd) return;
    switch (this.state) {
      case 'menu':
        this.start();
        break;
      case 'playing':
        this.switchLane();
        break;
      case 'paused':
        this.state = 'playing';
        this.reviving = false;
        break;
      case 'over':
        if (this.continueOffer <= 0 && this.overTime > 0.6) void this.leaveOver('retry');
        break;
      default:
        break;
    }
  }

  pause(): void {
    if (this.state === 'playing') this.state = 'paused';
  }

  /** Android back button. Returns true if handled (false lets the app exit). */
  back(): boolean {
    if (this.busy || this.simAd) return true;
    switch (this.state) {
      case 'playing':
        this.pause();
        return true;
      case 'paused':
        if (this.reviving) return true;
        this.finalizeRun();
        this.goHome();
        return true;
      case 'over':
        if (this.continueOffer > 0) this.finalizeRun();
        else void this.leaveOver('home');
        return true;
      case 'shop':
      case 'missions':
        this.state = 'menu';
        return true;
      default:
        return false;
    }
  }

  onAppPause(): void {
    this.pause();
    this.sfx.suspend();
    saveProfile(this.profile);
  }

  onAppResume(): void {
    // Audio resumes on the next tap (unlock) to respect autoplay policies.
  }

  private selectSkin(id: string): void {
    const p = this.profile;
    const skin = skinById(id);
    if (p.owned.includes(id)) {
      p.skin = id;
    } else if (p.gems >= skin.price) {
      p.gems -= skin.price;
      p.owned.push(id);
      p.skin = id;
      this.sfx.buy();
      gemHaptic();
      this.showToast(`${skin.name} unlocked!`, skin.glow);
    } else {
      this.sfx.denied();
      this.shopShake = { id, t: 0.4 };
      this.showToast(`Need ${skin.price - p.gems} more gems`, '#ff8a8a');
      return;
    }
    saveProfile(p);
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
    this.progress = 0;
    this.streak = 0;
    this.mult = 1;
    this.shield = false;
    this.invuln = 0;
    this.timers = { magnet: 0, slow: 0, double: 0 };
    this.gameTime = 0;
    this.lastSwitchAngle = -99;
    this.switches = 0;
    this.stats = emptyStats();
    this.newBest = false;
    this.usedContinue = false;
    this.continueOffer = 0;
    this.reviving = false;
    this.doubledGems = false;
    this.finalized = false;
    this.zone = this.prevZone = 0;
    this.zoneFade = 1;
    this.banner.life = 0;
    this.toast.life = 0;
    this.nextSpawn = this.angle + SPAWN_LEAD + (this.profile.tutorialDone ? 0 : 1.2);
  }

  private start(): void {
    this.replaceDoneMissions();
    this.reset();
    this.banked = this.profile.missions.map((m) => m.progress);
    this.state = 'playing';
    tapHaptic();
  }

  private goHome(): void {
    this.replaceDoneMissions();
    this.reset();
    this.state = 'menu';
  }

  private replaceDoneMissions(): void {
    const p = this.profile;
    for (let i = 0; i < p.missions.length; i++) {
      if (!p.missions[i].done) continue;
      p.missionLevel++;
      p.missions[i] = newMission(p.missionLevel, p.missions.map((m) => m.type));
    }
    while (p.missions.length < 3) p.missions.push(newMission(p.missionLevel, p.missions.map((m) => m.type)));
    saveProfile(p);
  }

  private switchLane(): void {
    this.lastSwitchFrom = this.lane;
    this.lastSwitchAngle = this.angle;
    this.lane = this.lane === 1 ? 0 : 1;
    this.switches++;
    this.sfx.switchLane(this.lane === 1);
    tapHaptic();
  }

  private gameOver(): void {
    const p = this.profile;
    this.state = 'over';
    this.overTime = 0;
    this.shake = 1;
    this.flash = 1;
    this.sfx.crash();
    crashHaptic();
    const pos = this.playerPos();
    this.burst(pos.x, pos.y, 46, ['#ffffff', skinById(p.skin).glow, '#ff6b6b', '#ffd166'], 1.6);

    // Offer one "watch an ad to continue" per run, once the run is worth saving.
    if (!this.usedContinue && this.score >= 10 && money.rewardedReady) this.continueOffer = 5;
    else this.finalizeRun();
  }

  /** Records the finished run: games played, gems, best score. */
  private finalizeRun(): void {
    const p = this.profile;
    this.continueOffer = 0;
    if (this.finalized) return;
    this.finalized = true;
    p.gamesPlayed++;
    p.gems += this.stats.gems;
    if (this.score > p.best) {
      p.best = this.score;
      this.newBest = true;
    }
    saveProfile(p);
  }

  private get canDoubleGems(): boolean {
    return !this.doubledGems && this.continueOffer <= 0 && this.stats.gems > 0 && money.rewardedReady;
  }

  private async watchToContinue(): Promise<void> {
    this.busy = true;
    const rewarded = await money.showRewarded();
    this.busy = false;
    if (rewarded) this.revive();
    else this.finalizeRun();
  }

  /** Second chance: clear nearby hazards and wait for the player to tap. */
  private revive(): void {
    this.usedContinue = true;
    this.continueOffer = 0;
    for (const o of this.objs) {
      const ahead = (o.kind === 'comet' ? o.target : o.a) - this.angle;
      if (isHazard(o) && ahead > -0.6 && ahead < 2.2) {
        o.dead = true;
        const op = this.objPos(o);
        this.burst(op.x, op.y, 12, ['#ff5d5d', '#ffffff'], 0.8);
      }
    }
    this.objs = this.objs.filter((o) => !o.dead);
    this.invuln = 2;
    this.trail = [];
    this.reviving = true;
    this.state = 'paused';
    this.sfx.powerUp();
  }

  private async watchToDoubleGems(): Promise<void> {
    this.busy = true;
    const rewarded = await money.showRewarded();
    this.busy = false;
    if (!rewarded) return;
    this.doubledGems = true;
    this.profile.gems += this.stats.gems;
    saveProfile(this.profile);
    this.showToast(`+${this.stats.gems} BONUS GEMS!`, '#ffd166');
    this.sfx.buy();
  }

  /** Leaves the game-over screen, showing an interstitial first when it's due. */
  private async leaveOver(next: 'retry' | 'home'): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    await money.afterGame(this.profile.gamesPlayed);
    this.busy = false;
    if (next === 'retry') this.start();
    else this.goHome();
  }

  private async buyRemoveAds(): Promise<void> {
    this.busy = true;
    const ok = await money.buyRemoveAds();
    this.busy = false;
    if (ok) {
      this.sfx.buy();
      this.showToast('Ads removed. Thank you!', '#7dff6b');
    }
  }

  private async restorePurchases(): Promise<void> {
    this.busy = true;
    const ok = await money.restore();
    this.busy = false;
    this.showToast(ok ? 'Purchases restored' : 'No purchases to restore', ok ? '#7dff6b' : '#ffffff');
  }

  // ------------------------------------------------------------------ update

  update(dt: number): void {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    this.flash = Math.max(0, this.flash - dt * 3);
    this.banner.life = Math.max(0, this.banner.life - dt);
    this.toast.life = Math.max(0, this.toast.life - dt);
    this.zoneFade = Math.min(1, this.zoneFade + dt / 1.5);
    this.shopShake.t = Math.max(0, this.shopShake.t - dt);

    if (this.simAd) {
      this.simAd.t += dt;
      if (this.simAd.t >= 2) {
        const done = this.simAd.done;
        this.simAd = null;
        done();
      }
      return;
    }

    if (this.state === 'paused') return;

    if (this.state === 'menu' || this.state === 'shop' || this.state === 'missions') {
      // Idle demo orbit behind the menus.
      this.angle += dt * 1.1;
      this.radius += (LANE_R[1] - this.radius) * (1 - Math.exp(-dt * LANE_EASE));
      this.pushTrail();
    }

    if (this.state === 'playing') this.updatePlaying(dt);
    if (this.state === 'over') {
      this.overTime += dt;
      if (this.continueOffer > 0 && !this.busy) {
        this.continueOffer -= dt;
        if (this.continueOffer <= 0) this.finalizeRun();
      }
    }

    this.updateFx(dt);
  }

  private updatePlaying(dt: number): void {
    this.timers.magnet = Math.max(0, this.timers.magnet - dt);
    this.timers.slow = Math.max(0, this.timers.slow - dt);
    this.timers.double = Math.max(0, this.timers.double - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    const gdt = dt * (this.timers.slow > 0 ? SLOW_FACTOR : 1);
    this.gameTime += gdt;

    const targetSpeed = Math.min(MAX_SPEED, BASE_SPEED + this.level * SPEED_PER_LEVEL);
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-dt * 2));
    this.angle += this.speed * gdt;
    this.radius += (LANE_R[this.lane] - this.radius) * (1 - Math.exp(-dt * LANE_EASE));
    this.pushTrail();

    while (this.angle + SPAWN_LEAD >= this.nextSpawn) this.spawnPattern();

    const p = this.playerPos();
    for (const o of this.objs) {
      if (o.dead) continue;
      o.age += dt;
      o.spin += dt * (o.kind === 'gem' ? 3 : o.kind === 'power' ? 1.5 : 0.8);
      o.a += o.vel * gdt;

      // Magnet pulls nearby gems (in either orbit) towards the ship.
      if (o.kind === 'gem' && o.fly < 0 && this.timers.magnet > 0 && o.a - this.angle < 0.75 && o.a - this.angle > -0.1) {
        const op = this.objPos(o);
        o.fly = 0;
        o.fx = op.x;
        o.fy = op.y;
      }
      if (o.fly >= 0) {
        o.fly += dt * 5;
        if (o.fly >= 1) this.collectGem(o);
        continue;
      }

      const op = this.objPos(o);
      const rr = this.radiusOf(o) + PLAYER_R;
      const dx = p.x - op.x;
      const dy = p.y - op.y;
      if (dx * dx + dy * dy < rr * rr * (isHazard(o) ? 0.8 : 1.4)) {
        if (isHazard(o)) {
          if (this.invuln > 0) continue;
          if (this.shield) {
            this.shieldSave(o, op);
            continue;
          }
          this.gameOver();
          return;
        }
        if (o.kind === 'gem') this.collectGem(o);
        else this.collectPower(o, op);
        continue;
      }

      // Crossing the player's angle: check for a close call.
      if (!o.crossed && o.a <= this.angle) {
        o.crossed = true;
        if (isHazard(o) && o.lane !== this.lane && this.lastSwitchFrom === o.lane) {
          // How far ahead the hazard was (in radians) when the player switched away.
          const gap = (this.angle - this.lastSwitchAngle) * (1 - o.vel / this.speed);
          if (gap < CLOSE_CALL) this.closeCall(op);
        }
      }

      // Passed behind the player.
      if (this.angle - o.a > 0.35) {
        o.dead = true;
        if (isHazard(o)) {
          this.addPoints(1);
          if (o.kind === 'comet') this.stats.comets++;
          this.sfx.pass();
        } else if (o.kind === 'gem') {
          if (this.mult > 1) this.addText(`x${this.mult} lost`, p.x, p.y, '#ff8a8a', 0.06);
          this.streak = 0;
          this.mult = 1;
        }
      }
    }
    this.objs = this.objs.filter((o) => !o.dead);

    this.stats.score = this.score;
    this.checkMissions();

    if (!this.profile.tutorialDone && this.score >= 5 && this.switches >= 2) {
      this.profile.tutorialDone = true;
      saveProfile(this.profile);
    }
  }

  private radiusOf(o: Obj): number {
    switch (o.kind) {
      case 'rock':
        return ROCK_R;
      case 'comet':
        return COMET_R;
      case 'power':
        return POWER_R;
      default:
        return GEM_R;
    }
  }

  private collectGem(o: Obj): void {
    o.dead = true;
    this.streak++;
    const mult = Math.min(MAX_MULT, 1 + Math.floor(this.streak / GEMS_PER_MULT));
    const p = this.playerPos();
    if (mult > this.mult) {
      this.mult = mult;
      this.stats.maxMultiplier = Math.max(this.stats.maxMultiplier, mult);
      this.showToast(`MULTIPLIER x${mult}`, '#ffd166');
    }
    this.stats.gems++;
    this.addPoints(3, p.x, p.y, '#ffd166');
    this.burst(p.x, p.y, 10, ['#ffd166', '#fff3b0'], 0.6);
    this.sfx.gem(this.streak);
    gemHaptic();
  }

  private collectPower(o: Obj, at: { x: number; y: number }): void {
    o.dead = true;
    const info = POWERS[o.power];
    if (o.power === 'shield') this.shield = true;
    else this.timers[o.power] = info.duration;
    this.stats.powerups++;
    this.showToast(info.name, info.color);
    this.burst(at.x, at.y, 22, [info.color, '#ffffff'], 1);
    this.sfx.powerUp();
    gemHaptic();
  }

  private shieldSave(o: Obj, at: { x: number; y: number }): void {
    o.dead = true;
    this.shield = false;
    this.invuln = 0.7;
    this.stats.shieldSaves++;
    this.shake = 0.45;
    this.burst(at.x, at.y, 30, ['#ff5d5d', '#7df9ff', '#ffffff'], 1.2);
    this.addText('SAVED!', at.x, at.y, '#7df9ff', 0.08);
    this.sfx.shieldBreak();
    crashHaptic();
  }

  private closeCall(at: { x: number; y: number }): void {
    this.stats.dodges++;
    this.addPoints(2);
    this.addText('CLOSE CALL +' + 2 * this.pointFactor(), at.x, at.y, '#7df9ff', 0.085);
    this.sfx.closeCall();
  }

  private pointFactor(): number {
    return this.mult * (this.timers.double > 0 ? 2 : 1);
  }

  private addPoints(base: number, x?: number, y?: number, color = '#ffffff'): void {
    const n = base * this.pointFactor();
    this.score += n;
    this.progress += base;
    if (x !== undefined && y !== undefined) this.addText(`+${n}`, x, y, color, 0.09);
    const lvl = Math.floor(this.progress / POINTS_PER_LEVEL);
    if (lvl > this.level) {
      this.level = lvl;
      this.prevZone = this.zone;
      this.zone = lvl % THEMES.length;
      this.zoneFade = 0;
      const faster = BASE_SPEED + lvl * SPEED_PER_LEVEL <= MAX_SPEED + SPEED_PER_LEVEL;
      this.banner = { title: `ZONE ${lvl + 1}`, sub: THEMES[this.zone].name + (faster ? ' · SPEED UP' : ''), life: 2.2 };
      this.sfx.levelUp();
    }
  }

  private checkMissions(): void {
    const done = updateMissions(this.profile.missions, this.stats, this.banked);
    for (const m of done) {
      this.profile.gems += m.reward;
      this.showToast(`MISSION COMPLETE +${m.reward}`, '#7dff6b');
      this.sfx.mission();
      saveProfile(this.profile);
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
    const ease = Math.max(0, 0.6 - this.progress * 0.02); // gentler start
    let gap = this.minGap() + ease + Math.random() * 0.35;
    const r = Math.random();

    if (this.progress >= 30 && r < 0.12) {
      // Comet: launched so it crosses slot `a` in its orbit exactly when the
      // player arrives there, so it behaves like a rock at `a` for fairness.
      const t = (a - this.angle) / this.speed;
      this.addObj(a + COMET_SPEED * t, lane, 'comet', { vel: -COMET_SPEED, target: a });
      if (Math.random() < 0.5) this.addObj(a, other, 'gem');
      gap += 0.3;
    } else if (this.progress >= 12 && r < 0.4) {
      // Zig-zag: rocks alternate lanes, forcing quick double switches.
      const n = this.progress >= 40 ? 3 : 2;
      const sep = this.minGap() + 0.05;
      for (let i = 0; i < n; i++) this.addObj(a + i * sep, (i % 2 === 0 ? lane : other) as 0 | 1, 'rock');
      if (Math.random() < 0.5) this.addObj(a + sep * 0.5, other, 'gem');
      gap += sep * (n - 1);
    } else if (r < 0.55) {
      // Gem arc: a short line of gems, sometimes capped with a power-up.
      for (let i = 0; i < 3; i++) this.addObj(a + i * 0.22, lane, 'gem');
      if (Math.random() < 0.15) this.addObj(a + 0.66, lane, 'power', { power: this.pickPower() });
      gap += 0.6;
    } else {
      // Single rock, with a gem or power-up in the safe lane.
      this.addObj(a, lane, 'rock');
      const q = Math.random();
      if (q < 0.1) this.addObj(a, other, 'power', { power: this.pickPower() });
      else if (q < 0.45) this.addObj(a, other, 'gem');
    }
    this.nextSpawn = a + gap;
  }

  private pickPower(): PowerKind {
    const pool = POWER_KINDS.filter((k) => !(k === 'shield' && this.shield));
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private addObj(a: number, lane: 0 | 1, kind: Kind, extra: { vel?: number; target?: number; power?: PowerKind } = {}): void {
    const shape: number[] = [];
    for (let i = 0; i < 8; i++) shape.push(0.78 + Math.random() * 0.32);
    this.objs.push({
      a,
      lane,
      kind,
      power: extra.power ?? 'shield',
      vel: extra.vel ?? 0,
      target: extra.target ?? a,
      age: 0,
      spin: Math.random() * 6,
      shape,
      dead: false,
      crossed: false,
      fly: -1,
      fx: 0,
      fy: 0,
    });
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
      t.life -= dt * 1.1;
      t.y -= dt * 0.25;
    }
    this.texts = this.texts.filter((t) => t.life > 0);
  }

  private addText(s: string, x: number, y: number, color: string, size: number): void {
    this.texts.push({ x, y, text: s, life: 1, color, size });
  }

  private showToast(s: string, color: string): void {
    this.toast = { text: s, color, life: 1.6 };
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
    if (o.fly >= 0) {
      const p = this.playerPos();
      const k = Math.min(1, o.fly);
      const e = k * k;
      return { x: o.fx + (p.x - o.fx) * e, y: o.fy + (p.y - o.fy) * e };
    }
    const r = LANE_R[o.lane];
    return { x: Math.cos(o.a) * r, y: Math.sin(o.a) * r };
  }

  /** Snapshot used by the automated playtest bot (dev builds only). */
  debugState() {
    return {
      angle: this.angle,
      lane: this.lane,
      speed: this.speed * (this.timers.slow > 0 ? SLOW_FACTOR : 1),
      objs: this.objs.map((o) => ({ a: o.a, lane: o.lane, kind: o.kind, vel: o.vel })),
    };
  }

  // ------------------------------------------------------------------ render

  render(ctx: CanvasRenderingContext2D): void {
    const { w, h } = this;
    const zone = this.state === 'playing' || this.state === 'paused' || this.state === 'over' ? this.zone : 0;
    const prev = this.state === 'playing' || this.state === 'paused' || this.state === 'over' ? this.prevZone : 0;
    this.drawBackground(ctx, THEMES[prev], 1);
    if (this.zoneFade < 1) this.drawBackground(ctx, THEMES[zone], this.zoneFade);
    const theme = THEMES[zone];

    ctx.save();
    if (this.shake > 0) {
      const s = this.shake * this.shake * 14;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    ctx.translate(this.cx, this.cy);
    const S = this.scale;

    this.drawStars(ctx, S);
    if (this.zoneFade < 1) this.drawPlanet(ctx, S, THEMES[prev], 1);
    this.drawPlanet(ctx, S, theme, this.zoneFade);
    this.drawPlanetLabel(ctx, S);
    this.drawLanes(ctx, S);
    for (const o of this.objs) if (o.kind === 'comet') this.drawCometMarker(ctx, o, S);
    for (const o of this.objs) this.drawObj(ctx, o, S);
    if (this.state !== 'over' && this.state !== 'shop' && this.state !== 'missions') this.drawPlayer(ctx, S);
    this.drawParticles(ctx, S);
    this.drawTexts(ctx, S);
    ctx.restore();

    if (this.state === 'playing' && this.timers.slow > 0) {
      const a = Math.min(1, this.timers.slow) * 0.35;
      const g = ctx.createRadialGradient(this.cx, this.cy, this.scale * 0.8, this.cx, this.cy, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(80, 120, 255, 0)');
      g.addColorStop(1, `rgba(80, 120, 255, ${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.35})`;
      ctx.fillRect(0, 0, w, h);
    }

    this.drawHud(ctx);
  }

  private drawBackground(ctx: CanvasRenderingContext2D, t: Theme, alpha: number): void {
    const bg = ctx.createLinearGradient(0, 0, 0, this.h);
    bg.addColorStop(0, t.bgTop);
    bg.addColorStop(1, t.bgBottom);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalAlpha = 1;
  }

  private drawStars(ctx: CanvasRenderingContext2D, S: number): void {
    const R = Math.max(this.w, this.h) / S;
    const rot = this.time * 0.02;
    ctx.fillStyle = '#ffffff';
    for (const s of this.stars) {
      const a = s.a + rot;
      const d = s.d * R * 0.75;
      const tw = 0.5 + 0.5 * Math.sin(this.time * 2 + s.phase);
      ctx.globalAlpha = 0.25 + tw * 0.6;
      ctx.fillRect(Math.cos(a) * d * S, Math.sin(a) * d * S, s.size, s.size);
    }
    ctx.globalAlpha = 1;
  }

  private drawPlanet(ctx: CanvasRenderingContext2D, S: number, t: Theme, alpha: number): void {
    const r = 0.3 * S;
    ctx.globalAlpha = alpha;
    const glow = ctx.createRadialGradient(0, 0, r * 0.8, 0, 0, r * 2.2);
    glow.addColorStop(0, `rgba(${t.glow}, 0.35)`);
    glow.addColorStop(1, `rgba(${t.glow}, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    const body = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, 0, 0, r);
    body.addColorStop(0, t.planet[0]);
    body.addColorStop(0.55, t.planet[1]);
    body.addColorStop(1, t.planet[2]);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** Score (while playing) or play button (on the menu) inside the planet. */
  private drawPlanetLabel(ctx: CanvasRenderingContext2D, S: number): void {
    const r = 0.3 * S;
    if (this.state === 'playing' || this.state === 'paused') {
      const color = this.timers.double > 0 ? '#ffd166' : 'rgba(255,255,255,0.95)';
      text(ctx, String(this.score), 0, r * 0.04, r * (this.score >= 1000 ? 0.55 : 0.75), color, 800);
    } else if (this.state === 'menu') {
      // Play triangle: the planet doubles as the play button.
      const pulse = 1 + Math.sin(this.time * 4) * 0.06;
      const s = r * 0.38 * pulse;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath();
      ctx.moveTo(-s * 0.6, -s);
      ctx.lineTo(s * 1.0, 0);
      ctx.lineTo(-s * 0.6, s);
      ctx.closePath();
      ctx.fill();
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

  /** Pulsing warning where an incoming comet will cross the player's path. */
  private drawCometMarker(ctx: CanvasRenderingContext2D, o: Obj, S: number): void {
    if (o.crossed) return;
    const r = LANE_R[o.lane] * S;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 12);
    ctx.strokeStyle = `rgba(255, 93, 93, ${0.35 + pulse * 0.5})`;
    ctx.lineWidth = S * 0.035;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, r, o.target - 0.09, o.target + 0.09);
    ctx.stroke();
    text(ctx, '!', Math.cos(o.target) * (r + S * 0.1), Math.sin(o.target) * (r + S * 0.1), S * 0.09, '#ff5d5d', 900);
  }

  private drawObj(ctx: CanvasRenderingContext2D, o: Obj, S: number): void {
    const p = this.objPos(o);
    const appear = Math.min(1, o.age / 0.25);
    const k = appear * (2 - appear) * (o.fly >= 0 ? 1 - o.fly * 0.5 : 1);

    if (o.kind === 'comet') {
      // Tail trails behind the comet (towards larger angles).
      const lr = LANE_R[o.lane];
      const steps = 10;
      for (let i = steps; i >= 1; i--) {
        const ta = o.a + i * 0.035;
        const f = 1 - i / (steps + 1);
        ctx.globalAlpha = f * 0.6 * k;
        ctx.fillStyle = i % 2 ? '#7df9ff' : '#b8f3ff';
        ctx.beginPath();
        ctx.arc(Math.cos(ta) * lr * S, Math.sin(ta) * lr * S, COMET_R * S * (0.25 + f * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(p.x * S, p.y * S);
      ctx.scale(k, k);
      ctx.shadowColor = '#ff5d5d';
      ctx.shadowBlur = COMET_R * S;
      ctx.fillStyle = '#ffe1e1';
      ctx.beginPath();
      ctx.arc(0, 0, COMET_R * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ff5d5d';
      ctx.beginPath();
      ctx.arc(0, 0, COMET_R * S * 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    if (o.kind === 'power') {
      const pulse = 1 + Math.sin(this.time * 5) * 0.08;
      const r = POWER_R * S * k * pulse;
      ctx.save();
      ctx.shadowColor = POWERS[o.power].color;
      ctx.shadowBlur = r * 1.2;
      powerIcon(ctx, o.power, p.x * S, p.y * S, r);
      ctx.restore();
      return;
    }

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
      gemIcon(ctx, 0, 0, r);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  private drawShip(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, skinId: string, trail: { x: number; y: number }[], alpha = 1): void {
    const skin = skinById(skinId);
    const n = trail.length;
    for (let i = 0; i < n; i++) {
      const t = trail[i];
      const f = i / n;
      ctx.globalAlpha = f * 0.55 * alpha;
      ctx.fillStyle = trailColor(skin, n - i, this.time);
      ctx.beginPath();
      ctx.arc(t.x, t.y, r * (0.3 + f * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.shadowColor = skin.rainbow ? trailColor(skin, 0, this.time) : skin.glow;
    ctx.shadowBlur = r * 1.2;
    ctx.fillStyle = skin.body;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, S: number): void {
    const p = this.playerPos();
    const blink = this.invuln > 0 && Math.floor(this.time * 20) % 2 === 0 ? 0.35 : 1;
    this.drawShip(ctx, p.x * S, p.y * S, PLAYER_R * S, this.profile.skin, this.trail.map((t) => ({ x: t.x * S, y: t.y * S })), blink);

    if (this.state !== 'playing' && this.state !== 'paused') return;
    if (this.shield) {
      const r = PLAYER_R * S * (1.75 + Math.sin(this.time * 6) * 0.08);
      ctx.strokeStyle = 'rgba(125, 249, 255, 0.85)';
      ctx.lineWidth = Math.max(2, S * 0.012);
      ctx.beginPath();
      ctx.arc(p.x * S, p.y * S, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(125, 249, 255, 0.12)';
      ctx.fill();
    }
    if (this.timers.magnet > 0) {
      ctx.strokeStyle = 'rgba(255, 107, 214, 0.6)';
      ctx.lineWidth = Math.max(1.5, S * 0.008);
      ctx.setLineDash([S * 0.02, S * 0.02]);
      ctx.lineDashOffset = this.time * S * 0.2;
      ctx.beginPath();
      ctx.arc(p.x * S, p.y * S, PLAYER_R * S * 2.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
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
    for (const t of this.texts) {
      ctx.globalAlpha = Math.max(0, Math.min(1, t.life * 1.5));
      text(ctx, t.text, t.x * S, t.y * S - S * 0.1, S * t.size, t.color, 900);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ HUD & menus

  private drawHud(ctx: CanvasRenderingContext2D): void {
    const btns = this.buttons();
    const btn = (id: string) => btns.find((b) => b.id === id);
    const { cx, base } = this;

    switch (this.state) {
      case 'menu':
        this.drawMenu(ctx, btn);
        break;
      case 'playing':
      case 'paused':
        this.drawPlayHud(ctx, btn);
        break;
      case 'over':
        this.drawGameOver(ctx, btn);
        break;
      case 'shop':
        this.dim(ctx, 0.82);
        this.drawShop(ctx, btns);
        break;
      case 'missions':
        this.dim(ctx, 0.82);
        this.drawMissions(ctx);
        break;
    }
    if (this.state === 'shop' || this.state === 'missions') this.iconButton(ctx, btn('back')!, 'back');

    // Toasts sit just above the orbit.
    if (this.toast.life > 0) {
      const a = Math.min(1, this.toast.life * 3);
      const y =
        this.state === 'shop'
          ? this.h - this.safe.bottom - 14
          : this.state === 'over'
            ? this.h - this.safe.bottom - Math.min(56, base * 0.14) - 56
            : this.cy - this.scale - base * 0.06;
      ctx.globalAlpha = a;
      text(ctx, this.toast.text, cx, y, base * 0.05, this.toast.color, 900);
      ctx.globalAlpha = 1;
    }

    if (this.simAd) {
      // Dev builds only: stands in for a real AdMob ad.
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, this.w, this.h);
      text(ctx, 'TEST AD', cx, this.cy - 30, base * 0.1, '#ffffff', 900);
      text(ctx, this.simAd.kind === 'rewarded' ? 'Rewarded video' : 'Interstitial', cx, this.cy + 10, base * 0.045, 'rgba(255,255,255,0.7)', 700);
      text(ctx, `${Math.ceil(2 - this.simAd.t)}`, cx, this.cy + 60, base * 0.07, '#7dff6b', 900);
      text(ctx, '(simulated: real ads only appear in the app)', cx, this.h - this.safe.bottom - 40, base * 0.035, 'rgba(255,255,255,0.4)', 600);
    }
  }

  private dim(ctx: CanvasRenderingContext2D, a: number): void {
    ctx.fillStyle = `rgba(8, 8, 24, ${a})`;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private wallet(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    const s = String(this.profile.gems);
    ctx.font = `800 20px ${FONT}`;
    const w = ctx.measureText(s).width + 44;
    roundRect(ctx, x - w, y - 18, w, 36, 18);
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fill();
    gemIcon(ctx, x - w + 18, y, 9);
    text(ctx, s, x - w + 32, y + 1, 20, '#ffd166', 800, 'left');
  }

  private iconButton(ctx: CanvasRenderingContext2D, b: Btn, kind: 'sound' | 'pause' | 'back'): void {
    const x = b.x + b.w / 2;
    const y = b.y + b.h / 2;
    const r = 22;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const s = r * 0.42;
    if (kind === 'pause') {
      const bw = r * 0.22;
      const bh = r * 0.8;
      ctx.fillRect(x - bw * 1.6, y - bh / 2, bw, bh);
      ctx.fillRect(x + bw * 0.6, y - bh / 2, bw, bh);
    } else if (kind === 'back') {
      ctx.beginPath();
      ctx.moveTo(x + s * 0.35, y - s);
      ctx.lineTo(x - s * 0.55, y);
      ctx.lineTo(x + s * 0.35, y + s);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(x - s * 1.1, y - s * 0.45);
      ctx.lineTo(x - s * 0.45, y - s * 0.45);
      ctx.lineTo(x + s * 0.25, y - s);
      ctx.lineTo(x + s * 0.25, y + s);
      ctx.lineTo(x - s * 0.45, y + s * 0.45);
      ctx.lineTo(x - s * 1.1, y + s * 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 2;
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
  }

  private drawMenu(ctx: CanvasRenderingContext2D, btn: (id: string) => Btn | undefined): void {
    const { cx, base } = this;
    this.iconButton(ctx, btn('sound')!, 'sound');
    this.wallet(ctx, this.w - this.safe.right - 70, this.safe.top + 36);

    const orbitTop = this.cy - this.scale;
    const titleY = this.safe.top + 60 + (orbitTop - this.safe.top - 60) * 0.45;
    text(ctx, 'ORBIT DASH', cx, titleY, base * 0.13, '#ffffff', 900);
    text(ctx, this.best > 0 ? `BEST ${this.best}` : 'Tap to switch orbits', cx, titleY + base * 0.085, base * 0.042, this.best > 0 ? '#ffd166' : 'rgba(255,255,255,0.65)', 700);

    const pulse = 0.55 + 0.45 * Math.sin(this.time * 4);
    const shop = btn('shop')!;
    const playY = (this.cy + this.scale + shop.y) / 2;
    text(ctx, 'TAP TO PLAY', cx, playY, base * 0.055, `rgba(255,255,255,${pulse})`, 800);

    button(ctx, shop, 'SHOP', false);
    const ms = btn('missions')!;
    button(ctx, ms, 'MISSIONS', false);
  }

  private drawPlayHud(ctx: CanvasRenderingContext2D, btn: (id: string) => Btn | undefined): void {
    const { cx, base } = this;
    const top = this.safe.top + 36;
    this.iconButton(ctx, btn('pause') ?? { id: 'pause', x: this.safe.left + 14, y: this.safe.top + 14, w: 44, h: 44 }, 'pause');
    text(ctx, `BEST ${Math.max(this.best, this.score)}`, cx, top, base * 0.04, 'rgba(255,255,255,0.55)', 700);

    // Multiplier and progress to the next one.
    const mx = this.w - this.safe.right - 44;
    text(ctx, `x${this.mult}`, mx, top - 2, base * (this.mult > 1 ? 0.07 : 0.05), this.mult > 1 ? '#ffd166' : 'rgba(255,255,255,0.4)', 900);
    if (this.mult < MAX_MULT) progressBar(ctx, mx - 24, top + 18, 48, 5, (this.streak % GEMS_PER_MULT) / GEMS_PER_MULT, '#ffd166');

    // Active power-ups along the bottom.
    const active: { kind: PowerKind; frac: number }[] = [];
    if (this.shield) active.push({ kind: 'shield', frac: 1 });
    for (const k of ['magnet', 'slow', 'double'] as const) if (this.timers[k] > 0) active.push({ kind: k, frac: this.timers[k] / POWERS[k].duration });
    const iy = this.h - this.safe.bottom - 48;
    active.forEach((p, i) => {
      const x = cx + (i - (active.length - 1) / 2) * 60;
      powerIcon(ctx, p.kind, x, iy, 20);
      timerRing(ctx, x, iy, 25, p.frac, POWERS[p.kind].color);
    });

    if (this.banner.life > 0) {
      const a = Math.min(1, this.banner.life * 2, (2.2 - this.banner.life) * 4);
      const y = this.safe.top + 90;
      ctx.globalAlpha = a;
      text(ctx, this.banner.title, cx, y, base * 0.08, '#7df9ff', 900);
      text(ctx, this.banner.sub, cx, y + base * 0.065, base * 0.04, 'rgba(255,255,255,0.8)', 700);
      ctx.globalAlpha = 1;
    }

    if (!this.profile.tutorialDone && this.state === 'playing') {
      const a = 0.6 + 0.4 * Math.sin(this.time * 5);
      const y = this.cy + this.scale + (this.h - this.safe.bottom - this.cy - this.scale) * 0.45;
      ctx.globalAlpha = a;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, y - base * 0.08, 14 + 8 * ((this.time * 1.5) % 1), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      text(ctx, 'TAP anywhere to switch orbit', cx, y, base * 0.048, '#ffffff', 800);
      text(ctx, 'Dodge red rocks · grab gold gems', cx, y + base * 0.06, base * 0.036, 'rgba(255,255,255,0.7)', 600);
    }

    if (this.state === 'paused') {
      this.dim(ctx, 0.7);
      text(ctx, this.reviving ? 'READY?' : 'PAUSED', cx, this.cy - this.scale * 0.3 - base * 0.12, base * 0.12, '#ffffff', 900);
      const r = btn('resume');
      const h = btn('home');
      if (r) button(ctx, r, this.reviving ? 'GO!' : 'RESUME', true);
      if (h) button(ctx, h, 'HOME', false);
    }
  }

  private drawGameOver(ctx: CanvasRenderingContext2D, btn: (id: string) => Btn | undefined): void {
    const { cx, base } = this;
    const a = Math.min(1, this.overTime * 3);
    this.dim(ctx, 0.75 * a);
    ctx.globalAlpha = a;
    const top = this.safe.top;
    const bottom = this.h - this.safe.bottom;
    const bh = Math.min(56, base * 0.14);
    const dbl = btn('double');
    const retryY = (dbl ? dbl.y : bottom - bh - 28) - (dbl ? 4 : 0);

    if (this.continueOffer > 0 || (this.busy && !this.finalized)) {
      this.dim(ctx, 0.6 * a);
      this.drawContinueOffer(ctx, btn);
      ctx.globalAlpha = 1;
      return;
    }

    let y = top + Math.max(50, (this.h - top - this.safe.bottom) * 0.09);
    text(ctx, 'GAME OVER', cx, y, base * 0.08, '#ff6b6b', 900);
    y += base * 0.17;
    text(ctx, String(this.score), cx, y, base * 0.2, '#ffffff', 900);
    y += base * 0.14;
    if (this.newBest) {
      const p = 1 + Math.sin(this.time * 6) * 0.05;
      text(ctx, 'NEW BEST!', cx, y, base * 0.06 * p, '#ffd166', 900);
    } else {
      text(ctx, `BEST ${this.best}`, cx, y, base * 0.05, '#ffd166', 800);
    }
    y += base * 0.09;
    gemAmount(ctx, `+${this.stats.gems * (this.doubledGems ? 2 : 1)}`, cx, y, base * 0.05);

    // Missions
    y += base * 0.08;
    const rowH = Math.min(64, (retryY - 16 - y) / 3);
    if (rowH > 36) this.missionRows(ctx, y, rowH);

    const r = btn('retry');
    const h = btn('home');
    if (r) button(ctx, r, 'RETRY', true);
    if (h) button(ctx, h, 'HOME', false);
    if (dbl) this.adButton(ctx, dbl, `DOUBLE GEMS (+${this.stats.gems})`);
    ctx.globalAlpha = 1;
  }

  /** "Continue?" screen with a countdown ring, shown right after a crash. */
  private drawContinueOffer(ctx: CanvasRenderingContext2D, btn: (id: string) => Btn | undefined): void {
    const { cx, base } = this;
    const y = this.cy - base * 0.12;
    text(ctx, 'CONTINUE?', cx, y - base * 0.24, base * 0.1, '#ffffff', 900);
    text(ctx, `Score ${this.score}`, cx, y - base * 0.14, base * 0.045, 'rgba(255,255,255,0.7)', 700);
    const r = base * 0.11;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, y + base * 0.04, r, 0, Math.PI * 2);
    ctx.stroke();
    timerRing(ctx, cx, y + base * 0.04, r, Math.max(0, this.continueOffer) / 5, '#7dff6b');
    text(ctx, String(Math.max(1, Math.ceil(this.continueOffer))), cx, y + base * 0.045, r * 1.1, '#ffffff', 900);
    const c = btn('continue');
    const d = btn('decline');
    if (c) this.adButton(ctx, c, 'KEEP GOING');
    if (d) text(ctx, 'No thanks', d.x + d.w / 2, d.y + d.h / 2, base * 0.042, 'rgba(255,255,255,0.6)', 700);
  }

  /** Green button with a small "play video" badge: marks a rewarded ad. */
  private adButton(ctx: CanvasRenderingContext2D, b: Btn, label: string): void {
    roundRect(ctx, b.x, b.y, b.w, b.h, b.h / 2);
    const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    g.addColorStop(0, '#b6ff9f');
    g.addColorStop(1, '#4fd66a');
    ctx.fillStyle = g;
    ctx.fill();
    const iconR = b.h * 0.26;
    const ix = b.x + b.h * 0.55;
    const iy = b.y + b.h / 2;
    ctx.fillStyle = '#0b0d1f';
    ctx.beginPath();
    ctx.arc(ix, iy, iconR, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b6ff9f';
    ctx.beginPath();
    ctx.moveTo(ix - iconR * 0.35, iy - iconR * 0.5);
    ctx.lineTo(ix + iconR * 0.55, iy);
    ctx.lineTo(ix - iconR * 0.35, iy + iconR * 0.5);
    ctx.closePath();
    ctx.fill();
    text(ctx, label, b.x + b.w / 2 + b.h * 0.35, iy + 1, Math.min(b.h * 0.36, (b.w - b.h * 1.3) / label.length * 1.75), '#0b0d1f', 900);
  }

  private missionRows(ctx: CanvasRenderingContext2D, y: number, rowH: number): void {
    const width = Math.min(this.w - 32, 460);
    const left = (this.w - width) / 2;
    this.profile.missions.forEach((m: MissionState, i) => {
      const ry = y + i * rowH;
      roundRect(ctx, left, ry, width, rowH - 8, 12);
      ctx.fillStyle = m.done ? 'rgba(125, 255, 107, 0.14)' : 'rgba(255,255,255,0.07)';
      ctx.fill();
      const fs = Math.min(17, rowH * 0.28);
      text(ctx, describeMission(m), left + 14, ry + (rowH - 8) * 0.34, fs, m.done ? '#7dff6b' : '#ffffff', 700, 'left');
      if (m.done) {
        text(ctx, '✓ DONE', left + width - 14, ry + (rowH - 8) * 0.34, fs, '#7dff6b', 900, 'right');
      } else {
        ctx.font = `800 ${Math.round(fs)}px ${FONT}`;
        const label = String(m.reward);
        const tw = ctx.measureText(label).width;
        text(ctx, label, left + width - 14, ry + (rowH - 8) * 0.34, fs, '#ffd166', 800, 'right');
        gemIcon(ctx, left + width - 22 - tw, ry + (rowH - 8) * 0.34, fs * 0.42);
      }
      const barY = ry + (rowH - 8) * 0.68;
      progressBar(ctx, left + 14, barY - 3, width - 120, 6, m.progress / m.target, m.done ? '#7dff6b' : '#7df9ff');
      text(ctx, `${m.progress}/${m.target}`, left + width - 14, barY, fs * 0.8, 'rgba(255,255,255,0.6)', 700, 'right');
    });
  }

  private drawMissions(ctx: CanvasRenderingContext2D): void {
    const { cx, base } = this;
    const top = this.safe.top + 36;
    text(ctx, 'MISSIONS', cx, top, base * 0.065, '#ffffff', 900);
    this.wallet(ctx, this.w - this.safe.right - 16, top);
    const y = this.safe.top + 100;
    text(ctx, 'Complete missions to earn gems.', cx, y, base * 0.04, 'rgba(255,255,255,0.7)', 600);
    text(ctx, 'Spend gems on new ship skins!', cx, y + base * 0.055, base * 0.04, 'rgba(255,255,255,0.7)', 600);
    this.missionRows(ctx, y + base * 0.12, 76);
    text(ctx, `Games played: ${this.profile.gamesPlayed}`, cx, this.h - this.safe.bottom - 40, base * 0.036, 'rgba(255,255,255,0.45)', 600);
  }

  private drawShop(ctx: CanvasRenderingContext2D, btns: Btn[]): void {
    const { cx, base } = this;
    const top = this.safe.top + 36;
    text(ctx, 'SHOP', cx, top, base * 0.065, '#ffffff', 900);
    this.wallet(ctx, this.w - this.safe.right - 16, top);
    const ra = btns.find((b) => b.id === 'removeAds');
    if (ra) {
      roundRect(ctx, ra.x, ra.y, ra.w, ra.h, 14);
      ctx.fillStyle = money.adsRemoved ? 'rgba(125, 255, 107, 0.12)' : 'rgba(255, 107, 214, 0.16)';
      ctx.fill();
      ctx.strokeStyle = money.adsRemoved ? 'rgba(125, 255, 107, 0.5)' : 'rgba(255, 107, 214, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const my = ra.y + ra.h / 2;
      if (money.adsRemoved) {
        text(ctx, '✓ ADS REMOVED · THANK YOU!', cx, my, 16, '#7dff6b', 900);
      } else {
        text(ctx, 'REMOVE ADS', ra.x + 16, my - 8, 17, '#ffffff', 900, 'left');
        text(ctx, 'No more ads between games', ra.x + 16, my + 11, 12, 'rgba(255,255,255,0.65)', 600, 'left');
        const pw = 86;
        roundRect(ctx, ra.x + ra.w - pw - 10, my - 16, pw, 32, 16);
        ctx.fillStyle = '#ff6bd6';
        ctx.fill();
        text(ctx, money.removeAdsPrice, ra.x + ra.w - pw / 2 - 10, my + 1, 16, '#0b0d1f', 900);
      }
      for (const id of ['restore', 'privacy']) {
        const b = btns.find((x) => x.id === id);
        if (b) text(ctx, id === 'restore' ? 'Restore purchases' : 'Ad privacy choices', b.x + b.w / 2, b.y + b.h / 2, 13, 'rgba(255,255,255,0.55)', 700);
      }
    } else {
      text(ctx, 'Collect gems while you play to unlock ships', cx, this.safe.top + 84, base * 0.036, 'rgba(255,255,255,0.65)', 600);
    }

    const p = this.profile;
    for (const b of btns) {
      if (!b.id.startsWith('skin:')) continue;
      const skin = skinById(b.id.slice(5));
      const owned = p.owned.includes(skin.id);
      const equipped = p.skin === skin.id;
      const shakeX = this.shopShake.id === skin.id ? Math.sin(this.shopShake.t * 60) * 6 * this.shopShake.t * 2.5 : 0;
      const x = b.x + shakeX;

      roundRect(ctx, x, b.y, b.w, b.h, 16);
      ctx.fillStyle = equipped ? 'rgba(125, 249, 255, 0.16)' : 'rgba(255,255,255,0.07)';
      ctx.fill();
      ctx.strokeStyle = equipped ? '#7df9ff' : 'rgba(255,255,255,0.15)';
      ctx.lineWidth = equipped ? 2.5 : 1.5;
      ctx.stroke();

      // Ship preview orbiting a tiny arc.
      const pcx = x + b.w / 2;
      const pcy = b.y + b.h * 0.4;
      const rr = Math.min(b.w, b.h) * 0.22;
      const ang = this.time * 2.2;
      const trail: { x: number; y: number }[] = [];
      for (let i = 14; i >= 1; i--) trail.push({ x: pcx + Math.cos(ang - i * 0.09) * rr, y: pcy + Math.sin(ang - i * 0.09) * rr });
      ctx.globalAlpha = owned ? 1 : 0.55;
      this.drawShip(ctx, pcx + Math.cos(ang) * rr, pcy + Math.sin(ang) * rr, Math.max(6, b.h * 0.055), skin.id, trail, owned ? 1 : 0.6);
      ctx.globalAlpha = 1;

      const fs = Math.min(18, b.h * 0.12);
      text(ctx, skin.name, pcx, b.y + b.h * 0.74, fs, '#ffffff', 800);
      const sy = b.y + b.h * 0.89;
      if (equipped) text(ctx, 'EQUIPPED', pcx, sy, fs * 0.8, '#7df9ff', 900);
      else if (owned) text(ctx, 'TAP TO EQUIP', pcx, sy, fs * 0.75, 'rgba(255,255,255,0.6)', 800);
      else gemAmount(ctx, String(skin.price), pcx, sy, fs * 0.9, p.gems >= skin.price ? '#ffd166' : 'rgba(255, 209, 102, 0.5)');
    }
  }
}
