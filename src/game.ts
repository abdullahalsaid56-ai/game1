import { Sfx } from './audio';
import {
  BOSSES,
  PLANETS,
  POWERS,
  POWER_KINDS,
  SKINS,
  describeMission,
  newMission,
  skinById,
  updateMissions,
  type BossKind,
  type Planet,
  type PowerKind,
  type RunStats,
  type Theme,
} from './content';
import {
  DAILY_REWARDS,
  MAX_STATION_LEVEL,
  STATION_INFO,
  UPGRADES,
  addXp,
  buildStation,
  buyUpgrade,
  claimDaily,
  collect,
  collectAll,
  dailyAvailable,
  nextFullAt,
  pendingGems,
  rankReward,
  stationCap,
  stationRate,
  tickStations,
  upgradeCost,
  upgradeLevel,
  upgradeStation,
  xpForRun,
  xpToNext,
  type UpgradeId,
} from './meta';
import { money } from './monetize';
import { askNotificationPermission, crashHaptic, gemHaptic, scheduleReminders, tapHaptic } from './native';
import { defaultProfile, loadProfile, saveProfile, type MissionState, type Profile } from './profile';
import { FONT, button, gemAmount, gemIcon, hit, powerIcon, progressBar, roundRect, text, timerRing, trailColor, type Rect } from './ui';

// ---------------------------------------------------------------------------
// World units: the outer orbit has radius 1. Everything is scaled to the
// screen at render time, so gameplay is identical on every device size.
// ---------------------------------------------------------------------------
const TWO_LANES = [0.62, 1.0];
const THREE_LANES = [0.5, 0.75, 1.0];
const PLAYER_R = 0.055;
const ROCK_R = 0.065;
const GEM_R = 0.05;
const POWER_R = 0.06;
const COMET_R = 0.06;
const SPAWN_LEAD = 2.7; // radians ahead of the player where objects appear
const LANE_EASE = 22; // higher = faster lane switch
const ICE_EASE = 7; // slippery lane switches on the ice planet
const STAGE_LEN = 24; // un-multiplied points needed to finish a planet
const FLARE_W = 0.14; // half-width (radians) of a solar flare
const GATE_R = 0.1;
const DRIFT_SPEED = 0.35; // black hole: rocks drift towards the player
const WARP_DUR = 4.6; // seconds of warp flight between planets
const WARP_Y = 0.55; // ship's screen position during warp (world units below centre)
const WARP_X = 0.32; // corridor lane offset
const BOSS_DUR = 20;
const BOSS_INTRO = 2.2;
const WORM_SPEED = 1.6; // radians / second, against the player
const WORM_SEGS = 13;
const WORM_SPACING = 0.09;
const BASE_SPEED = 1.6; // radians / second
const SPEED_PER_LEVEL = 0.22;
const MAX_SPEED = 3.7;
const COMET_SPEED = 0.8; // radians / second, towards the player
const SLOW_FACTOR = 0.55;
const GEMS_PER_MULT = 4;
const MAX_MULT = 5;
const CLOSE_CALL = 0.45; // radians: switching away this close to a hazard counts as a close call

type State = 'menu' | 'shop' | 'missions' | 'galaxy' | 'hangar' | 'playing' | 'paused' | 'over';
type Modal = { kind: 'daily'; day: number } | { kind: 'welcome'; gems: number };
type Kind = 'rock' | 'gem' | 'comet' | 'power' | 'flare' | 'beam' | 'gate';
/** Phases of a run on each planet. */
type Phase = 'stage' | 'bossIntro' | 'boss' | 'gate' | 'warp';

interface Boss {
  kind: BossKind;
  t: number; // seconds into the fight
  // worm
  headA: number;
  headLane: number;
  startLane: number; // lane of body segments that haven't reached any switch point
  switches: { a: number; lane: number }[];
  segR: number[]; // current radius of each segment (eases between orbits)
  prevD: number;
}

interface Obj {
  a: number; // absolute (unwrapped) angle
  lane: number;
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
  y: number; // warp flight only: vertical position in the corridor
  armed: boolean; // flares and beams: currently deadly
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

const isHazard = (o: Obj) => o.kind === 'rock' || o.kind === 'comet' || o.kind === 'flare' || o.kind === 'beam';
const TAU = Math.PI * 2;
const wrap = (a: number) => ((a % TAU) + TAU) % TAU;

function emptyStats(): RunStats {
  return { score: 0, gems: 0, dodges: 0, powerups: 0, shieldSaves: 0, maxMultiplier: 1, comets: 0, planets: 1, bosses: 0 };
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
  private lane = 1;
  private laneDir = -1; // gas giant: next tap moves inward (-1) or outward (+1)
  private lanes = TWO_LANES;
  private shrink = 1; // black hole: orbits shrink over the planet
  private radius = TWO_LANES[1];
  private warpX = WARP_X;
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
  private lastSwitchFrom = 1;
  private switches = 0;
  private stats: RunStats = emptyStats();
  private banked: number[] = [];
  private newBest = false;
  private overTime = 0;
  private planetIdx = 0;
  private prevPlanet = 0;
  private zoneFade = 1;
  private phase: Phase = 'stage';
  private stageEnd = STAGE_LEN;
  private phaseT = 0; // seconds in the current phase
  private boss: Boss | null = null;
  private gate: Obj | null = null;
  private warpNext = 0; // warp: time of next debris spawn
  private banner = { title: '', sub: '', life: 0 };
  private toast = { text: '', color: '#fff', life: 0 };

  // shop
  private shopShake = { id: '', t: 0 };

  // meta-game
  private modals: Modal[] = [];
  private selectedPlanet = 0;
  private metaTick = 0;
  private runXp = 0;
  private ranksGained: number[] = [];
  private discoveries: string[] = [];
  private comboSaves = 0;

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
    this.welcomeBack();

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

  /** On launch / return: queue the daily reward and the stations' offline earnings. */
  private welcomeBack(): void {
    const p = this.profile;
    const now = Date.now();
    const away = now - p.lastSeen;
    tickStations(p, now);
    p.lastSeen = now;
    if (this.state !== 'menu' && this.state !== 'galaxy' && this.state !== 'hangar') return;
    const day = dailyAvailable(p);
    if (day && !this.modals.some((m) => m.kind === 'daily')) this.modals.push({ kind: 'daily', day });
    const gems = pendingGems(p);
    if (away > 3 * 60_000 && gems >= 5 && p.gamesPlayed > 0 && !this.modals.some((m) => m.kind === 'welcome')) this.modals.push({ kind: 'welcome', gems });
    saveProfile(p);
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
    if (this.modalOpen) return this.modalButtons();
    return this.screenButtons();
  }

  private get modalOpen(): boolean {
    return this.modals.length > 0 && (this.state === 'menu' || this.state === 'galaxy' || this.state === 'hangar');
  }

  /** Buttons of the current screen, ignoring any popup on top. */
  private screenButtons(): Btn[] {
    const { w, base } = this;
    const top = this.safe.top + 14;
    const bottom = this.h - this.safe.bottom;
    const icon = (id: string, x: number): Btn => ({ id, x: x - 22, y: top, w: 44, h: 44 });
    const bw = Math.min(base * 0.42, 200);
    const bh = Math.min(56, base * 0.14);
    const cx = this.cx;

    switch (this.state) {
      case 'menu': {
        const gh = Math.min(52, base * 0.13);
        const row2 = bottom - gh - 24;
        const row1 = row2 - gh - 12;
        return [
          icon('sound', w - this.safe.right - 36),
          { id: 'galaxy', x: cx - bw - 8, y: row1, w: bw, h: gh },
          { id: 'hangar', x: cx + 8, y: row1, w: bw, h: gh },
          { id: 'shop', x: cx - bw - 8, y: row2, w: bw, h: gh },
          { id: 'missions', x: cx + 8, y: row2, w: bw, h: gh },
        ];
      }
      case 'galaxy':
        return [icon('back', this.safe.left + 36), ...this.galaxyButtons()];
      case 'hangar':
        return [icon('back', this.safe.left + 36), ...this.hangarButtons()];
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

  private modalRect(): Rect {
    const mw = Math.min(this.w - 40, 360);
    const mh = 330;
    return { x: (this.w - mw) / 2, y: this.cy - mh / 2, w: mw, h: mh };
  }

  private modalButtons(): Btn[] {
    const m = this.modals[0];
    const r = this.modalRect();
    const bw = r.w - 48;
    if (m.kind === 'daily') return [{ id: 'claimDaily', x: r.x + 24, y: r.y + r.h - 74, w: bw, h: 52 }];
    const list: Btn[] = [{ id: 'collectWelcome', x: r.x + 24, y: r.y + r.h - 74, w: bw, h: 52 }];
    if (money.rewardedReady) list.push({ id: 'collectWelcome2x', x: r.x + 24, y: r.y + r.h - 136, w: bw, h: 52 });
    return list;
  }

  /** Galaxy map layout: planets zig-zag upwards from Home, with a detail panel below. */
  private galaxyLayout() {
    const panelH = 164;
    const panelY = this.h - this.safe.bottom - panelH - 12;
    const areaTop = this.safe.top + 118;
    const r = Math.max(14, Math.min(32, (panelY - areaTop) / PLANETS.length * 0.3));
    const top = areaTop + r * 1.4;
    const bottomY = panelY - r - 40;
    const off = Math.min(this.w * 0.22, 120);
    const step = (bottomY - top) / (PLANETS.length - 1);
    const nodes = PLANETS.map((_, i) => ({ x: this.cx + (i % 2 === 0 ? -off : off) * (i === 0 ? 0.4 : 1), y: bottomY - i * step, r }));
    const width = Math.min(this.w - 32, 460);
    return { nodes, panel: { x: (this.w - width) / 2, y: panelY, w: width, h: panelH } };
  }

  private galaxyButtons(): Btn[] {
    const { nodes, panel } = this.galaxyLayout();
    const list: Btn[] = nodes.map((n, i) => ({ id: `planet:${i}`, x: n.x - n.r * 1.6, y: n.y - n.r * 1.3, w: n.r * 3.2, h: n.r * 2.9 }));
    list.push({ id: 'collectAll', x: this.cx - 130, y: this.safe.top + 66, w: 260, h: 44 });
    const p = this.profile;
    const i = this.selectedPlanet;
    const by = panel.y + panel.h - 60;
    if (p.stations[i]) {
      list.push({ id: 'collectOne', x: panel.x + 16, y: by, w: panel.w / 2 - 24, h: 44 });
      list.push({ id: 'upgradeStation', x: panel.x + panel.w / 2 + 8, y: by, w: panel.w / 2 - 24, h: 44 });
    } else if (p.discovered.includes(i)) {
      list.push({ id: 'build', x: panel.x + 40, y: by, w: panel.w - 80, h: 44 });
    }
    return list;
  }

  private hangarButtons(): Btn[] {
    const top = this.safe.top + 110;
    const rowH = Math.min(92, (this.h - this.safe.bottom - 20 - top) / UPGRADES.length);
    const width = Math.min(this.w - 32, 460);
    const left = (this.w - width) / 2;
    return UPGRADES.map((u, i) => ({ id: `upg:${u.id}`, x: left + width - 112, y: top + i * rowH + (rowH - 8) / 2 - 20, w: 100, h: 40 }));
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
    if (this.modalOpen) return;
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
    if (id.startsWith('planet:')) {
      this.selectedPlanet = Number(id.slice(7));
      return;
    }
    if (id.startsWith('upg:')) {
      this.buyHangarUpgrade(id.slice(4) as UpgradeId);
      return;
    }
    if (this.pressMeta(id)) return;
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
      case 'galaxy':
        tickStations(this.profile);
        this.state = 'galaxy';
        break;
      case 'hangar':
        this.state = 'hangar';
        break;
      case 'back':
        this.state = 'menu';
        break;
    }
  }

  /** The single game action: start / switch lane / resume / retry. */
  action(): void {
    this.sfx.unlock();
    if (this.busy || this.simAd || this.modalOpen) return;
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
      case 'galaxy':
      case 'hangar':
        if (this.modals.length) return true;
        this.state = 'menu';
        return true;
      default:
        return false;
    }
  }

  onAppPause(): void {
    this.pause();
    this.sfx.suspend();
    const p = this.profile;
    tickStations(p);
    p.lastSeen = Date.now();
    saveProfile(p);
    const full = Object.entries(p.stations).reduce((n, [k, st]) => n + stationCap(Number(k), st.level), 0);
    const day = dailyAvailable(p, new Date(Date.now() + 86_400_000));
    void scheduleReminders({ stationsFullAt: nextFullAt(p), fullGems: full, dailyDay: day || 1, streak: p.daily.streak });
  }

  onAppResume(): void {
    // Audio resumes on the next tap (unlock) to respect autoplay policies.
    this.welcomeBack();
  }

  /** Galaxy, hangar and popup buttons. Returns true if handled. */
  private pressMeta(id: string): boolean {
    const p = this.profile;
    switch (id) {
      case 'collectAll': {
        tickStations(p);
        const n = collectAll(p);
        if (n > 0) this.gemsCollected(n);
        else this.showToast('Nothing to collect yet', '#ffffff');
        break;
      }
      case 'collectOne': {
        tickStations(p);
        const n = collect(p, this.selectedPlanet);
        if (n > 0) this.gemsCollected(n);
        break;
      }
      case 'build':
        if (buildStation(p, this.selectedPlanet)) {
          this.sfx.buy();
          gemHaptic();
          this.showToast(`${PLANETS[this.selectedPlanet].name} station built!`, '#7dff6b');
          if (!p.notificationsAsked) {
            p.notificationsAsked = true;
            void askNotificationPermission();
          }
        } else this.notEnough(STATION_INFO[this.selectedPlanet].build);
        break;
      case 'upgradeStation': {
        const st = p.stations[this.selectedPlanet];
        if (!st || st.level >= MAX_STATION_LEVEL) break;
        const cost = upgradeCost(this.selectedPlanet, st.level);
        if (upgradeStation(p, this.selectedPlanet)) {
          this.sfx.buy();
          gemHaptic();
          this.showToast(`Station level ${st.level}!`, '#7dff6b');
        } else this.notEnough(cost);
        break;
      }
      case 'claimDaily': {
        const n = claimDaily(p);
        this.modals.shift();
        if (n > 0) this.gemsCollected(n, `Day ${p.daily.streak} reward: +${n} gems!`);
        break;
      }
      case 'collectWelcome':
      case 'collectWelcome2x':
        void this.collectWelcome(id === 'collectWelcome2x');
        break;
      default:
        return false;
    }
    saveProfile(p);
    return true;
  }

  private gemsCollected(n: number, msg = `+${n} gems collected!`): void {
    this.sfx.buy();
    gemHaptic();
    this.showToast(msg, '#ffd166');
  }

  private notEnough(cost: number): void {
    this.sfx.denied();
    this.showToast(`Need ${cost - this.profile.gems} more gems`, '#ff8a8a');
  }

  private async collectWelcome(double: boolean): Promise<void> {
    const p = this.profile;
    if (double) {
      this.busy = true;
      const ok = await money.showRewarded();
      this.busy = false;
      if (!ok) return;
    }
    this.modals.shift();
    tickStations(p);
    const n = collectAll(p);
    if (double) p.gems += n;
    saveProfile(p);
    this.gemsCollected(double ? n * 2 : n, `+${double ? n * 2 : n} gems collected!`);
  }

  private buyHangarUpgrade(id: UpgradeId): void {
    const p = this.profile;
    const u = UPGRADES.find((x) => x.id === id)!;
    const lvl = upgradeLevel(p, id);
    if (lvl >= u.costs.length) return;
    if (buyUpgrade(p, id)) {
      this.sfx.buy();
      gemHaptic();
      this.showToast(`${u.name} ${u.costs.length > 1 ? `level ${lvl + 1}` : 'unlocked'}!`, '#7dff6b');
      saveProfile(p);
    } else this.notEnough(u.costs[lvl]);
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
    this.lanes = TWO_LANES;
    this.shrink = 1;
    this.laneDir = -1;
    this.radius = TWO_LANES[1];
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
    this.planetIdx = this.prevPlanet = 0;
    this.zoneFade = 1;
    this.phase = 'stage';
    this.phaseT = 0;
    this.stageEnd = STAGE_LEN;
    this.boss = null;
    this.gate = null;
    this.banner.life = 0;
    this.toast.life = 0;
    this.nextSpawn = this.angle + SPAWN_LEAD + (this.profile.tutorialDone ? 0 : 1.2);
  }

  private start(): void {
    this.replaceDoneMissions();
    this.reset();
    this.banked = this.profile.missions.map((m) => m.progress);
    this.shield = upgradeLevel(this.profile, 'shieldStart') > 0;
    this.comboSaves = upgradeLevel(this.profile, 'comboSaver');
    this.runXp = 0;
    this.ranksGained = [];
    this.discoveries = [];
    this.state = 'playing';
    if (this.profile.tutorialDone) this.banner = { title: 'HOME', sub: 'Planet 1 · Fill the bar, then fly through the warp gate', life: 2.6 };
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
    this.lane = this.nextLane();
    if (this.lanes.length > 2 && (this.lane === 0 || this.lane === this.lanes.length - 1)) this.laneDir = this.lane === 0 ? 1 : -1;
    this.switches++;
    this.sfx.switchLane(this.lane > this.lastSwitchFrom);
    tapHaptic();
  }

  /** Lane a tap would move to. Two orbits swap; three orbits bounce in and out. */
  private nextLane(): number {
    if (this.lanes.length === 2 || this.phase === 'warp') return 1 - Math.min(this.lane, 1);
    return this.lane + this.laneDir;
  }

  private get planet(): Planet {
    return PLANETS[this.planetIdx];
  }

  /** Radius of an orbit, including the black hole's shrink. */
  private laneR(i: number): number {
    return (this.lanes[i] ?? this.lanes[this.lanes.length - 1]) * this.shrink;
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
    this.stats.score = this.score;
    this.runXp = xpForRun(this.stats);
    this.ranksGained = addXp(p, this.runXp);
    if (this.ranksGained.length) {
      this.showToast(`PILOT RANK ${p.rank}! +${this.ranksGained.reduce((n, r) => n + rankReward(r), 0)} gems`, '#7df9ff');
      this.sfx.levelUp();
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
      const ahead = this.phase === 'warp' ? 0 : (o.vel !== 0 ? o.target : o.a) - this.angle;
      if (isHazard(o) && ahead > -0.6 && ahead < 2.2) {
        o.dead = true;
        const op = this.objPos(o);
        this.burst(op.x, op.y, 12, ['#ff5d5d', '#ffffff'], 0.8);
      }
    }
    this.objs = this.objs.filter((o) => !o.dead);
    const b = this.boss;
    if (b && b.kind === 'worm') {
      // Send the worm round to the far side of the planet.
      b.headA = this.angle + Math.PI;
      b.switches = [];
      b.startLane = b.headLane;
      b.segR.fill(this.laneR(b.headLane));
      b.prevD = Math.PI;
    }
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

    if (this.state === 'menu' || this.state === 'galaxy') {
      this.metaTick += dt;
      if (this.metaTick > 1) {
        this.metaTick = 0;
        tickStations(this.profile);
      }
    }

    if (this.state === 'menu' || this.state === 'shop' || this.state === 'missions' || this.state === 'galaxy' || this.state === 'hangar') {
      // Idle demo orbit behind the menus.
      this.angle += dt * 1.1;
      this.radius += (TWO_LANES[1] - this.radius) * (1 - Math.exp(-dt * LANE_EASE));
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
    this.phaseT += dt;

    const targetSpeed = Math.min(MAX_SPEED, BASE_SPEED + this.level * SPEED_PER_LEVEL);
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-dt * 2));

    if (this.phase === 'warp') this.updateWarp(dt, gdt);
    else this.updateOrbit(dt, gdt);
    if (this.state !== 'playing') return;

    this.stats.score = this.score;
    this.checkMissions();

    if (!this.profile.tutorialDone && this.score >= 5 && this.switches >= 2) {
      this.profile.tutorialDone = true;
      saveProfile(this.profile);
    }
  }

  /** Fraction of the current planet completed (0..1). */
  private stageFrac(): number {
    return Math.max(0, Math.min(1, 1 - (this.stageEnd - this.progress) / STAGE_LEN));
  }

  private updateOrbit(dt: number, gdt: number): void {
    this.angle += this.speed * gdt;
    const ease = this.planet.twist === 'ice' ? ICE_EASE : LANE_EASE;
    if (this.planet.twist === 'drift') this.shrink = 1 - 0.22 * this.stageFrac();
    this.radius += (this.laneR(this.lane) - this.radius) * (1 - Math.exp(-dt * ease));
    this.pushTrail();

    if (this.phase === 'stage' || this.phase === 'gate') while (this.angle + SPAWN_LEAD >= this.nextSpawn) this.spawnPattern();
    if (this.phase === 'bossIntro' && this.phaseT >= BOSS_INTRO) this.startBoss();
    if (this.phase === 'boss' && this.boss) {
      this.updateBoss(this.boss, dt, gdt);
      if (this.state !== 'playing') return;
    }

    const p = this.playerPos();
    for (const o of this.objs) {
      if (o.dead) continue;
      o.age += dt;
      o.spin += dt * (o.kind === 'gem' ? 3 : o.kind === 'power' ? 1.5 : 0.8);
      o.a += o.vel * gdt;

      // Flares and laser beams fire as the player approaches (always telegraphed first).
      if ((o.kind === 'flare' || o.kind === 'beam') && !o.armed && o.a - this.angle < this.speed * 0.5) {
        o.armed = true;
        if (o.kind === 'beam') this.sfx.laser();
        else this.sfx.flare();
      }

      // Magnet pulls nearby gems (in any orbit) towards the ship.
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
      if (this.touches(o, p, op)) {
        if (o.kind === 'gate') {
          this.startWarp();
          return;
        }
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
          if (gap < CLOSE_CALL + (o.kind === 'flare' ? FLARE_W : 0)) this.closeCall(op);
        }
      }

      // Passed behind the player.
      if (this.angle - o.a > 0.35 + (o.kind === 'flare' ? FLARE_W : 0)) {
        if (o.kind === 'gate') {
          // Missed the gate: it comes around again next lap.
          o.a += TAU;
          o.crossed = false;
          continue;
        }
        o.dead = true;
        if (isHazard(o)) {
          this.addPoints(1);
          if (o.kind === 'comet') this.stats.comets++;
          this.sfx.pass();
        } else if (o.kind === 'gem') {
          this.missedGem();
        }
      }
    }
    this.objs = this.objs.filter((o) => !o.dead);

    if (this.phase === 'stage' && this.progress >= this.stageEnd) {
      if (this.planet.boss) this.startBossIntro();
      else this.startGate();
    }
  }

  /** Collision test between the ship and an object, by object shape. */
  private touches(o: Obj, p: { x: number; y: number }, op: { x: number; y: number }): boolean {
    if (this.phase !== 'warp' && (o.kind === 'flare' || o.kind === 'beam')) {
      if (!o.armed) return false;
      const lr = this.laneR(o.lane);
      if (Math.abs(this.radius - lr) > 0.09) return false;
      const da = Math.abs(this.angle - o.a);
      return o.kind === 'flare' ? da < FLARE_W + 0.02 : da * this.radius < PLAYER_R * 0.9;
    }
    const rr = (o.kind === 'gate' ? GATE_R : this.radiusOf(o)) + PLAYER_R;
    const dx = p.x - op.x;
    const dy = p.y - op.y;
    return dx * dx + dy * dy < rr * rr * (isHazard(o) ? 0.8 : 1.4);
  }

  // ------------------------------------------------------------------ planets, gates and warp

  private startGate(): void {
    this.phase = 'gate';
    this.phaseT = 0;
    const lane = Math.floor(Math.random() * this.lanes.length);
    const a = Math.max(this.nextSpawn, this.angle + SPAWN_LEAD) + 0.4;
    for (let i = 3; i >= 1; i--) this.addObj(a - i * 0.22, lane, 'gem');
    this.gate = this.addObj(a, lane, 'gate');
    this.nextSpawn = a + this.minGap() + 0.8;
    this.banner = { title: 'WARP GATE', sub: 'Fly through it to reach the next planet!', life: 2.6 };
    this.sfx.levelUp();
  }

  private startWarp(): void {
    this.phase = 'warp';
    this.phaseT = 0;
    this.objs = [];
    this.gate = null;
    this.lane = 1;
    this.warpX = WARP_X;
    this.warpNext = 0.9;
    this.trail = [];
    this.flash = 0.7;
    this.prevPlanet = this.planetIdx;
    this.addPoints(5);
    this.sfx.warp();
    gemHaptic();
    this.banner = { title: 'WARP!', sub: 'Dodge the debris', life: 1.6 };
  }

  private get warpSpeed(): number {
    return 2.6 + this.level * 0.12;
  }

  /** Ship position during warp: in the corridor, then gliding into the new orbit. */
  private warpShipPos(): { x: number; y: number } {
    const k = Math.max(0, Math.min(1, (this.phaseT - (WARP_DUR - 0.9)) / 0.9));
    const e = k * k * (3 - 2 * k);
    return { x: this.warpX * (1 - e), y: WARP_Y + (1 - WARP_Y) * e };
  }

  private updateWarp(dt: number, gdt: number): void {
    const v = this.warpSpeed;
    this.warpX += ((this.lane === 0 ? -WARP_X : WARP_X) - this.warpX) * (1 - Math.exp(-dt * LANE_EASE));
    for (const t of this.trail) t.y += v * gdt * 0.5;
    this.pushTrail();

    if (this.phaseT >= this.warpNext && this.phaseT < WARP_DUR - 1.4) this.spawnDebris();
    if (this.phaseT > WARP_DUR - 0.9 && this.objs.length) {
      // Clear leftover debris as the ship glides into its new orbit.
      for (const o of this.objs) {
        const op = this.objPos(o);
        this.burst(op.x, op.y, 6, ['#ffffff', '#7df9ff'], 0.5);
      }
      this.objs = [];
    }

    const p = this.playerPos();
    for (const o of this.objs) {
      if (o.dead) continue;
      o.age += dt;
      o.spin += dt * 1.5;
      o.y += v * gdt;
      if (o.kind === 'gem' && o.fly < 0 && this.timers.magnet > 0 && o.y > p.y - 1.0 && o.y < p.y + 0.1) {
        o.fly = 0;
        o.fx = (o.lane === 0 ? -1 : 1) * WARP_X;
        o.fy = o.y;
      }
      if (o.fly >= 0) {
        o.fly += dt * 5;
        if (o.fly >= 1) this.collectGem(o);
        continue;
      }
      const op = this.objPos(o);
      if (this.touches(o, p, op)) {
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
      if (o.y > p.y + 0.35) {
        o.dead = true;
        if (isHazard(o)) {
          this.addPoints(1);
          this.sfx.pass();
        } else if (o.kind === 'gem') {
          this.missedGem();
        }
      }
    }
    this.objs = this.objs.filter((o) => !o.dead);

    if (this.phaseT >= WARP_DUR) this.arrive();
  }

  private spawnDebris(): void {
    const top = -this.cy / this.scale - 0.3;
    const lane = Math.random() < 0.5 ? 0 : 1;
    const q = Math.random();
    this.addObj(0, lane, 'rock', { y: top });
    if (q < 0.1 * this.luck) this.addObj(0, 1 - lane, 'power', { y: top, power: this.pickPower() });
    else if (q < 0.55) this.addObj(0, 1 - lane, 'gem', { y: top });
    this.warpNext += Math.max(0.42, 0.6 - this.level * 0.015) + Math.random() * 0.22;
  }

  private arrive(): void {
    this.planetIdx = (this.planetIdx + 1) % PLANETS.length;
    this.boss = null;
    this.level++;
    this.stats.planets++;
    this.phase = 'stage';
    this.phaseT = 0;
    this.objs = [];
    this.lanes = this.planet.twist === 'three' ? THREE_LANES : TWO_LANES;
    this.shrink = 1;
    this.lane = this.lanes.length - 1;
    this.laneDir = -1;
    this.angle = Math.PI / 2;
    this.radius = this.laneR(this.lane);
    this.lastSwitchAngle = -99;
    this.trail = [];
    this.nextSpawn = this.angle + SPAWN_LEAD + 0.5;
    this.stageEnd = this.progress + STAGE_LEN;
    this.banner = { title: this.planet.name.toUpperCase(), sub: `Planet ${this.stats.planets} · ${this.planet.hint}`, life: 3 };
    if (!this.profile.discovered.includes(this.planetIdx)) {
      this.profile.discovered.push(this.planetIdx);
      this.discoveries.push(this.planet.name);
      this.showToast('NEW PLANET DISCOVERED!', '#7dff6b');
      saveProfile(this.profile);
    }
    this.flash = 0.4;
    this.sfx.arrive();
  }

  // ------------------------------------------------------------------ bosses

  private startBossIntro(): void {
    this.phase = 'bossIntro';
    this.phaseT = 0;
    const info = BOSSES[this.planet.boss!];
    this.banner = { title: 'WARNING!', sub: `${info.name} APPROACHING`, life: BOSS_INTRO + 0.4 };
    this.sfx.siren();
    crashHaptic();
  }

  private startBoss(): void {
    const lane = Math.floor(Math.random() * this.lanes.length);
    this.phase = 'boss';
    this.phaseT = 0;
    this.boss = {
      kind: this.planet.boss!,
      t: 0,
      headA: this.angle + Math.PI,
      headLane: lane,
      startLane: lane,
      switches: [],
      segR: new Array(WORM_SEGS).fill(this.laneR(lane)),
      prevD: Math.PI,
    };
    this.nextSpawn = Math.max(this.nextSpawn, this.angle + 1.2);
  }

  private updateBoss(b: Boss, dt: number, gdt: number): void {
    b.t += gdt;
    if (b.kind === 'worm') this.updateWorm(b, dt, gdt);
    else this.updateUfo(b);
    if (this.state !== 'playing') return;
    if (b.t >= BOSS_DUR) this.defeatBoss(b);
  }

  /** Lane of the worm's body at angle `a`: it follows the path its head took. */
  private wormLaneAt(b: Boss, a: number): number {
    let lane = b.startLane;
    for (const sw of b.switches) if (a <= sw.a) lane = sw.lane;
    return lane;
  }

  private wormSegPos(b: Boss, i: number): { x: number; y: number; a: number } {
    const a = b.headA + i * WORM_SPACING;
    return { x: Math.cos(a) * b.segR[i], y: Math.sin(a) * b.segR[i], a };
  }

  private updateWorm(b: Boss, dt: number, gdt: number): void {
    b.headA -= WORM_SPEED * gdt;
    const d = wrap(b.headA - this.angle);
    if (d > b.prevD + Math.PI) {
      // The head just passed the player, so the next meeting is about a lap away:
      // the only safe moment to change orbit (the whole body clears the switch
      // point before the player gets there, and the player has time to react).
      this.addPoints(2);
      const p = this.playerPos();
      this.addText('DODGED!', p.x, p.y, '#b36bff', 0.08);
      const dMin = Math.max((WORM_SEGS * WORM_SPACING * this.speed) / WORM_SPEED + (this.speed + WORM_SPEED) * 0.3, (this.speed + WORM_SPEED) * 0.75);
      if (d >= dMin && Math.random() < 0.75) {
        const options = this.lanes.map((_, i) => i).filter((i) => i !== b.headLane);
        b.headLane = options[Math.floor(Math.random() * options.length)];
        b.switches.push({ a: b.headA, lane: b.headLane });
      }
    }
    b.prevD = d;

    // Forget switch points the whole body has passed.
    const tailA = b.headA + (WORM_SEGS - 1) * WORM_SPACING;
    while (b.switches.length && tailA <= b.switches[0].a) b.startLane = b.switches.shift()!.lane;

    const p = this.playerPos();
    for (let i = 0; i < WORM_SEGS; i++) {
      const a = b.headA + i * WORM_SPACING;
      b.segR[i] += (this.laneR(this.wormLaneAt(b, a)) - b.segR[i]) * (1 - Math.exp(-dt * 16));
      const sp = this.wormSegPos(b, i);
      const rr = (i === 0 ? 0.075 : 0.06) + PLAYER_R * 0.85;
      if ((p.x - sp.x) ** 2 + (p.y - sp.y) ** 2 < rr * rr && this.invuln <= 0) {
        if (this.shield) {
          this.shield = false;
          this.invuln = 1.2;
          this.stats.shieldSaves++;
          this.shake = 0.45;
          this.burst(sp.x, sp.y, 30, ['#b36bff', '#7df9ff', '#ffffff'], 1.2);
          this.addText('SAVED!', sp.x, sp.y, '#7df9ff', 0.08);
          this.sfx.shieldBreak();
          crashHaptic();
        } else {
          this.gameOver();
        }
        return;
      }
    }

    // Gems to chase during the fight.
    while (this.angle + SPAWN_LEAD >= this.nextSpawn) {
      if (b.t < BOSS_DUR - 2 && Math.random() < 0.6) {
        const lane = Math.floor(Math.random() * this.lanes.length);
        for (let i = 0; i < 3; i++) this.addObj(this.nextSpawn + i * 0.2, lane, 'gem');
      }
      this.nextSpawn += 1.4;
    }
  }

  /** The UFO hovers above the orbits, drifting from side to side. */
  private ufoPos(): { x: number; y: number } {
    return { x: Math.sin(this.time * 0.8) * 0.45, y: -1.35 + Math.sin(this.time * 3) * 0.015 };
  }

  private updateUfo(b: Boss): void {
    while (this.angle + SPAWN_LEAD >= this.nextSpawn) {
      const a = this.nextSpawn;
      if (b.t > BOSS_DUR - 2) {
        this.nextSpawn += 1;
        continue;
      }
      const lane = Math.floor(Math.random() * this.lanes.length);
      const other = (lane + 1) % this.lanes.length;
      const sep = this.minGap() + 0.05;
      if (Math.random() < 0.4) {
        // Double shot: one beam per orbit, staggered just enough to weave through.
        this.addObj(a, lane, 'beam');
        this.addObj(a + sep, other, 'beam');
        this.nextSpawn = a + sep + this.minGap() + Math.random() * 0.3;
      } else {
        this.addObj(a, lane, 'beam');
        if (Math.random() < 0.5) this.addObj(a, other, 'gem');
        this.nextSpawn = a + this.minGap() + 0.1 + Math.random() * 0.3;
      }
    }
  }

  private defeatBoss(b: Boss): void {
    const info = BOSSES[b.kind];
    if (b.kind === 'worm') {
      for (let i = 0; i < WORM_SEGS; i += 2) {
        const sp = this.wormSegPos(b, i);
        this.burst(sp.x, sp.y, 10, [info.color, '#ffd166', '#ffffff'], 1.2);
      }
    } else {
      const u = this.ufoPos();
      this.burst(u.x, u.y, 50, [info.color, '#ffd166', '#ffffff'], 1.8);
    }
    this.boss = null;
    this.objs = this.objs.filter((o) => o.kind !== 'beam');
    this.stats.bosses++;
    this.stats.gems += 10;
    this.addPoints(20);
    this.shake = 0.7;
    this.flash = 0.5;
    this.showToast(`${info.name} DEFEATED! +10 GEMS`, '#ffd166');
    this.sfx.bossDefeated();
    gemHaptic();
    this.startGate();
  }

  private radiusOf(o: Obj): number {
    switch (o.kind) {
      case 'rock':
        return ROCK_R;
      case 'comet':
        return COMET_R;
      case 'gate':
        return GATE_R;
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
    if (Math.random() < 0.1 * upgradeLevel(this.profile, 'gemBonus')) {
      this.stats.gems++;
      this.addText('GEM x2', p.x, p.y - 0.08, '#fff3b0', 0.07);
    }
    this.addPoints(3, p.x, p.y, '#ffd166');
    this.burst(p.x, p.y, 10, ['#ffd166', '#fff3b0'], 0.6);
    this.sfx.gem(this.streak);
    gemHaptic();
  }

  private missedGem(): void {
    if (this.mult <= 1) {
      this.streak = 0;
      return;
    }
    const p = this.playerPos();
    if (this.comboSaves > 0) {
      this.comboSaves--;
      this.addText('COMBO SAVED', p.x, p.y, '#7df9ff', 0.06);
      return;
    }
    this.addText(`x${this.mult} lost`, p.x, p.y, '#ff8a8a', 0.06);
    this.streak = 0;
    this.mult = 1;
  }

  private collectPower(o: Obj, at: { x: number; y: number }): void {
    o.dead = true;
    const info = POWERS[o.power];
    if (o.power === 'shield') this.shield = true;
    else this.timers[o.power] = info.duration + (o.power === 'magnet' ? 1.5 * upgradeLevel(this.profile, 'magnet') : 0);
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
    let g = 0.45 + this.speed * 0.28;
    const t = this.planet.twist;
    if (t === 'ice') g += 0.3 + this.speed * 0.12;
    if (t === 'flares') g += FLARE_W * 2;
    if (t === 'three') g *= 1.1;
    return g;
  }

  private spawnPattern(): void {
    const a = this.nextSpawn;
    if (this.phase === 'gate' && this.gate) {
      // Keep the space around the warp gate clear.
      const dist = Math.abs(wrap(a - this.gate.a + Math.PI) - Math.PI);
      if (dist < 1.1) {
        this.nextSpawn = a + 0.4;
        return;
      }
    }
    const twist = this.planet.twist;
    const n = this.lanes.length;
    const lane = Math.floor(Math.random() * n);
    const other = n === 2 ? 1 - lane : (lane + 1 + Math.floor(Math.random() * (n - 1))) % n;
    const ease = Math.max(0, 0.6 - this.progress * 0.02); // gentler start
    let gap = this.minGap() + ease + Math.random() * 0.35;
    const r = Math.random();
    const comets = n === 2 ? (twist === 'comets' ? 0.35 : this.progress >= 30 ? 0.1 : 0) : 0;

    if (r < comets) {
      // Comet: launched so it crosses slot `a` in its orbit exactly when the
      // player arrives there, so it behaves like a rock at `a` for fairness.
      const t = (a - this.angle) / this.speed;
      this.addObj(a + COMET_SPEED * t, lane, 'comet', { vel: -COMET_SPEED, target: a });
      if (Math.random() < 0.5) this.addObj(a, other, 'gem');
      gap += 0.3;
    } else if (n === 2 && this.progress >= 12 && r < comets + 0.28) {
      // Zig-zag: hazards alternate lanes, forcing quick double switches.
      const count = this.progress >= 40 ? 3 : 2;
      const sep = this.minGap() + 0.05;
      for (let i = 0; i < count; i++) this.hazard(a + i * sep, i % 2 === 0 ? lane : other);
      if (Math.random() < 0.5) this.addObj(a + sep * 0.5, other, 'gem');
      gap += sep * (count - 1);
    } else if (r < comets + 0.45) {
      // Gem arc: a short line of gems, sometimes capped with a power-up.
      for (let i = 0; i < 3; i++) this.addObj(a + i * 0.22, lane, 'gem');
      if (Math.random() < 0.15 * this.luck) this.addObj(a + 0.66, lane, 'power', { power: this.pickPower() });
      gap += 0.6;
    } else {
      // Single hazard, with a gem or power-up in a safe lane. On three orbits only
      // one orbit is ever blocked, so any tap (in or out) is always an escape.
      this.hazard(a, lane);
      const q = Math.random();
      if (q < 0.1 * this.luck) this.addObj(a, other, 'power', { power: this.pickPower() });
      else if (q < 0.45) this.addObj(a, other, 'gem');
    }
    this.nextSpawn = a + gap;
  }

  /** A planet-appropriate obstacle at slot `a`. */
  private hazard(a: number, lane: number): void {
    const twist = this.planet.twist;
    if (twist === 'flares' && Math.random() < 0.6) {
      this.addObj(a, lane, 'flare');
    } else if (twist === 'drift') {
      // Drifting rock, aimed (like comets) to reach slot `a` as the player does.
      const t = (a - this.angle) / this.speed;
      this.addObj(a + DRIFT_SPEED * t, lane, 'rock', { vel: -DRIFT_SPEED, target: a });
    } else {
      this.addObj(a, lane, 'rock');
    }
  }

  /** Power-up spawn multiplier from the Lucky Finds upgrade. */
  private get luck(): number {
    return 1 + 0.2 * upgradeLevel(this.profile, 'luck');
  }

  private pickPower(): PowerKind {
    const pool = POWER_KINDS.filter((k) => !(k === 'shield' && this.shield));
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private addObj(a: number, lane: number, kind: Kind, extra: { vel?: number; target?: number; power?: PowerKind; y?: number } = {}): Obj {
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
      y: extra.y ?? 0,
      armed: false,
    });
    return this.objs[this.objs.length - 1];
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
    if (this.phase === 'warp' && this.state !== 'menu') return this.warpShipPos();
    return { x: Math.cos(this.angle) * this.radius, y: Math.sin(this.angle) * this.radius };
  }

  private objPos(o: Obj): { x: number; y: number } {
    if (o.fly >= 0) {
      const p = this.playerPos();
      const k = Math.min(1, o.fly);
      const e = k * k;
      return { x: o.fx + (p.x - o.fx) * e, y: o.fy + (p.y - o.fy) * e };
    }
    if (this.phase === 'warp') return { x: (o.lane === 0 ? -1 : 1) * WARP_X, y: o.y };
    const r = this.laneR(o.lane);
    return { x: Math.cos(o.a) * r, y: Math.sin(o.a) * r };
  }

  /** Snapshot used by the automated playtest bot (dev builds only). */
  debugState() {
    const slow = this.timers.slow > 0 ? SLOW_FACTOR : 1;
    const threats: { lane: number; t0: number; t1: number }[] = [];
    let gate: { lane: number; t: number } | null = null;
    if (this.phase === 'warp') {
      const v = this.warpSpeed * slow;
      for (const o of this.objs) if (isHazard(o)) threats.push({ lane: o.lane, t0: (WARP_Y - 0.16 - o.y) / v, t1: (WARP_Y + 0.16 - o.y) / v });
    } else {
      const w = this.speed * slow;
      for (const o of this.objs) {
        if (o.kind === 'gate') gate = { lane: o.lane, t: (o.a - this.angle) / w };
        if (!isHazard(o)) continue;
        const rel = w - o.vel * slow;
        const half = o.kind === 'flare' ? FLARE_W + 0.12 : 0.16;
        threats.push({ lane: o.lane, t0: (o.a - this.angle - half) / rel, t1: (o.a - this.angle + half) / rel });
      }
      const b = this.boss;
      if (b && b.kind === 'worm') {
        const rel = (this.speed + WORM_SPEED) * slow;
        for (let i = 0; i < WORM_SEGS; i++) {
          const a = b.headA + i * WORM_SPACING;
          const d = wrap(a - this.angle + 1) - 1;
          threats.push({ lane: this.wormLaneAt(b, a), t0: (d - 0.17) / rel, t1: (d + 0.17) / rel });
        }
      }
    }
    return {
      angle: this.angle,
      phase: this.phase,
      planet: this.planet.name,
      lane: this.lane,
      nextLane: this.nextLane(),
      lanes: this.lanes.length,
      threats,
      gate,
      speed: this.speed * slow,
      objs: this.objs.map((o) => ({ a: o.a, lane: o.lane, kind: o.kind, vel: o.vel })),
    };
  }

  // ------------------------------------------------------------------ render

  render(ctx: CanvasRenderingContext2D): void {
    const { w, h } = this;
    const inRun = this.state === 'playing' || this.state === 'paused' || this.state === 'over';
    const planet = inRun ? this.planet : PLANETS[0];
    const warping = inRun && this.phase === 'warp';
    const warpK = warping ? this.smooth(this.phaseT / WARP_DUR) : 1;
    if (warping) {
      this.drawBackground(ctx, PLANETS[this.prevPlanet].theme, 1);
      this.drawBackground(ctx, PLANETS[(this.prevPlanet + 1) % PLANETS.length].theme, warpK);
    } else {
      this.drawBackground(ctx, planet.theme, 1);
    }

    ctx.save();
    if (this.shake > 0) {
      const s = this.shake * this.shake * 14;
      ctx.translate((Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    ctx.translate(this.cx, this.cy);
    const S = this.scale;

    if (warping) {
      this.drawWarpScene(ctx, S);
    } else {
      this.drawStars(ctx, S);
      this.drawPlanet(ctx, S, planet);
      this.drawPlanetLabel(ctx, S);
      this.drawLanes(ctx, S, planet);
      for (const o of this.objs) if (o.kind === 'comet') this.drawCometMarker(ctx, o, S);
      for (const o of this.objs) this.drawObj(ctx, o, S);
      if (inRun && this.boss) this.drawBoss(ctx, this.boss, S);
    }
    if (this.state === 'menu' || this.state === 'playing' || this.state === 'paused') this.drawPlayer(ctx, S);
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

  private smooth(k: number): number {
    const c = Math.max(0, Math.min(1, k));
    return c * c * (3 - 2 * c);
  }

  /** Warp flight: streaking stars, the old planet falling away, the new one arriving. */
  private drawWarpScene(ctx: CanvasRenderingContext2D, S: number): void {
    const T = this.phaseT;
    const halfH = this.cy / S + 0.5;
    const halfW = this.w / 2 / S;
    const speed = Math.min(1, T / 0.6) * Math.min(1, (WARP_DUR - T) / 0.8);

    // Streaking stars.
    ctx.strokeStyle = '#ffffff';
    ctx.lineCap = 'round';
    for (let i = 0; i < this.stars.length; i += 2) {
      const st = this.stars[i];
      const x = (Math.cos(st.a) * st.d * 0.7) * halfW;
      const span = halfH * 2;
      const y = (((Math.sin(st.a) * st.d * halfH + this.time * (1 + st.size) * 3) % span) + span) % span - halfH;
      ctx.globalAlpha = 0.15 + 0.35 * st.size / 1.7;
      ctx.lineWidth = st.size;
      ctx.beginPath();
      ctx.moveTo(x * S, y * S);
      ctx.lineTo(x * S, (y - 0.03 - speed * 0.18 * st.size) * S);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // The planet we left drops away; the next one rises into place.
    if (T < 1.4) {
      const e = this.smooth(T / 1.4);
      this.drawPlanet(ctx, S, PLANETS[this.prevPlanet], 1 - e * 0.3, 0, e * (halfH + 1), 1 + e * 0.6);
    }
    const arriveStart = WARP_DUR - 1.5;
    if (T > arriveStart) {
      const e = this.smooth((T - arriveStart) / 1.5);
      const next = PLANETS[(this.prevPlanet + 1) % PLANETS.length];
      this.drawPlanet(ctx, S, next, e, 0, -(halfH + 0.5) * (1 - e), 0.5 + 0.5 * e);
      if (e > 0.6) {
        ctx.globalAlpha = (e - 0.6) / 0.4;
        this.drawLanes(ctx, S, next, next.twist === 'three' ? THREE_LANES : TWO_LANES);
        ctx.globalAlpha = 1;
      }
    }

    // Corridor guides.
    if (T < WARP_DUR - 0.9) {
      ctx.setLineDash([S * 0.06, S * 0.08]);
      ctx.lineDashOffset = -this.time * S * this.warpSpeed;
      ctx.lineWidth = Math.max(1.5, S * 0.008);
      for (const x of [-WARP_X, WARP_X]) {
        const active = (x < 0 ? 0 : 1) === this.lane;
        ctx.strokeStyle = active ? 'rgba(125, 249, 255, 0.4)' : 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.moveTo(x * S, -halfH * S);
        ctx.lineTo(x * S, halfH * S);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    for (const o of this.objs) this.drawObj(ctx, o, S);
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

  private drawPlanet(ctx: CanvasRenderingContext2D, S: number, pl: Planet, alpha = 1, ox = 0, oy = 0, k = 1): void {
    const t: Theme = pl.theme;
    const r = 0.3 * S * k;
    ctx.save();
    ctx.translate(ox * S, oy * S);
    ctx.globalAlpha = alpha;

    if (pl.style === 'pulsar') {
      // Rotating light beams behind the star.
      ctx.save();
      ctx.rotate(this.time * 1.2);
      for (const dir of [0, Math.PI]) {
        const g = ctx.createLinearGradient(0, 0, Math.cos(dir) * r * 6, Math.sin(dir) * r * 6);
        g.addColorStop(0, `rgba(${t.glow}, 0.35)`);
        g.addColorStop(1, `rgba(${t.glow}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(dir - 0.12) * r * 6, Math.sin(dir - 0.12) * r * 6);
        ctx.lineTo(Math.cos(dir + 0.12) * r * 6, Math.sin(dir + 0.12) * r * 6);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    const glow = ctx.createRadialGradient(0, 0, r * 0.8, 0, 0, r * 2.2);
    glow.addColorStop(0, `rgba(${t.glow}, 0.35)`);
    glow.addColorStop(1, `rgba(${t.glow}, 0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.2, 0, Math.PI * 2);
    ctx.fill();

    if (pl.style === 'blackhole') {
      // Accretion disk (back half), the event horizon, then the disk's front half.
      const disk = (from: number, to: number) => {
        ctx.save();
        ctx.rotate(-0.35);
        ctx.scale(1, 0.32);
        for (let i = 0; i < 3; i++) {
          ctx.strokeStyle = ['rgba(255, 120, 40, 0.55)', 'rgba(255, 190, 90, 0.75)', 'rgba(255, 240, 200, 0.6)'][i];
          ctx.lineWidth = r * (0.32 - i * 0.09);
          ctx.beginPath();
          ctx.arc(0, 0, r * (1.7 - i * 0.18), from + this.time * 0.6, to + this.time * 0.6);
          ctx.stroke();
        }
        ctx.restore();
      };
      disk(Math.PI, Math.PI * 2);
      disk(0, Math.PI);
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 200, 120, 0.9)';
      ctx.lineWidth = Math.max(1.5, r * 0.05);
      ctx.stroke();
      ctx.save();
      ctx.rotate(-0.35);
      ctx.scale(1, 0.32);
      ctx.strokeStyle = 'rgba(255, 200, 110, 0.8)';
      ctx.lineWidth = r * 0.22;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.55, 0.15 + this.time * 0.6, Math.PI - 0.15 + this.time * 0.6);
      ctx.stroke();
      ctx.restore();
      ctx.restore();
      return;
    }

    const body = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, 0, 0, r);
    body.addColorStop(0, t.planet[0]);
    body.addColorStop(0.55, t.planet[1]);
    body.addColorStop(1, t.planet[2]);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    // Surface details, clipped to the planet.
    ctx.save();
    ctx.clip();
    if (pl.style === 'rocky') {
      ctx.fillStyle = 'rgba(30, 10, 80, 0.25)';
      for (const [cx, cy, cr] of [[0.35, 0.3, 0.18], [-0.4, 0.1, 0.12], [0.05, -0.45, 0.1], [-0.15, 0.55, 0.08]]) {
        ctx.beginPath();
        ctx.arc(cx * r, cy * r, cr * r, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (pl.style === 'lava') {
      ctx.strokeStyle = `rgba(255, 190, 70, ${0.55 + 0.3 * Math.sin(this.time * 3)})`;
      ctx.lineWidth = Math.max(1.5, r * 0.06);
      ctx.lineCap = 'round';
      for (const [x1, y1, x2, y2, x3, y3] of [[-0.9, -0.2, -0.2, -0.4, 0.3, 0.1], [-0.5, 0.6, 0, 0.2, 0.7, 0.4], [0.2, -0.9, 0.4, -0.4, 0.9, -0.3]]) {
        ctx.beginPath();
        ctx.moveTo(x1 * r, y1 * r);
        ctx.quadraticCurveTo(x2 * r, y2 * r, x3 * r, y3 * r);
        ctx.stroke();
      }
    } else if (pl.style === 'ice') {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.92, r * 0.7, r * 0.3, 0, 0, Math.PI * 2);
      ctx.ellipse(0, r * 0.95, r * 0.55, r * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(220, 250, 255, 0.5)';
      ctx.lineWidth = Math.max(1, r * 0.03);
      ctx.beginPath();
      ctx.moveTo(-r * 0.7, -r * 0.1);
      ctx.lineTo(-r * 0.2, r * 0.05);
      ctx.lineTo(r * 0.1, -r * 0.2);
      ctx.lineTo(r * 0.6, r * 0.15);
      ctx.stroke();
    } else if (pl.style === 'gas') {
      for (let i = -5; i <= 5; i++) {
        ctx.fillStyle = i % 2 ? 'rgba(255, 255, 255, 0.13)' : 'rgba(120, 50, 0, 0.16)';
        ctx.fillRect(-r, i * r * 0.2 + Math.sin(this.time + i) * r * 0.02, r * 2, r * 0.11);
      }
      ctx.fillStyle = 'rgba(190, 70, 30, 0.55)';
      ctx.beginPath();
      ctx.ellipse(r * 0.3, r * 0.35, r * 0.22, r * 0.12, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }

  /** Score (while playing) or play button (on the menu) inside the planet. */
  private drawPlanetLabel(ctx: CanvasRenderingContext2D, S: number): void {
    const r = 0.3 * S;
    if ((this.state === 'playing' || this.state === 'paused') && this.phase !== 'warp') {
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

  private drawLanes(ctx: CanvasRenderingContext2D, S: number, pl: Planet, lanes = this.lanes): void {
    ctx.lineWidth = Math.max(1.5, S * 0.008);
    ctx.setLineDash([S * 0.03, S * 0.045]);
    const ice = pl.twist === 'ice';
    lanes.forEach((lr, i) => {
      const active = this.state === 'playing' && this.lane === i && this.phase !== 'warp';
      ctx.strokeStyle = active ? (ice ? 'rgba(200, 245, 255, 0.7)' : 'rgba(125, 249, 255, 0.45)') : ice ? 'rgba(200, 245, 255, 0.25)' : 'rgba(255, 255, 255, 0.14)';
      ctx.lineDashOffset = -this.time * S * 0.08 * (i % 2 === 0 ? 1 : -1);
      ctx.beginPath();
      ctx.arc(0, 0, lr * (lanes === this.lanes ? this.shrink : 1) * S, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
  }

  /** Pulsing warning where an incoming comet will cross the player's path. */
  private drawCometMarker(ctx: CanvasRenderingContext2D, o: Obj, S: number): void {
    if (o.crossed) return;
    const r = this.laneR(o.lane) * S;
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

    if (o.kind === 'flare') {
      this.drawFlare(ctx, o, S, k);
      return;
    }
    if (o.kind === 'beam') {
      this.drawBeam(ctx, o, S, k);
      return;
    }
    if (o.kind === 'gate') {
      this.drawGate(ctx, p.x * S, p.y * S, S, k);
      return;
    }

    if (o.kind === 'comet') {
      // Tail trails behind the comet (towards larger angles).
      const lr = this.laneR(o.lane);
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

  private drawFlare(ctx: CanvasRenderingContext2D, o: Obj, S: number, k: number): void {
    const r = this.laneR(o.lane) * S;
    ctx.lineCap = 'round';
    if (!o.armed) {
      // Dormant: a glowing, pulsing warning strip on the orbit.
      const pulse = 0.4 + 0.35 * Math.sin(this.time * 10 + o.a);
      ctx.strokeStyle = `rgba(255, 140, 50, ${pulse * k})`;
      ctx.lineWidth = S * 0.035;
      ctx.setLineDash([S * 0.02, S * 0.02]);
      ctx.beginPath();
      ctx.arc(0, 0, r, o.a - FLARE_W, o.a + FLARE_W);
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    // Erupting: a bright band with flame tongues licking outwards.
    ctx.save();
    ctx.shadowColor = '#ff8a3d';
    ctx.shadowBlur = S * 0.08;
    ctx.strokeStyle = '#ffb347';
    ctx.lineWidth = S * 0.075;
    ctx.beginPath();
    ctx.arc(0, 0, r, o.a - FLARE_W, o.a + FLARE_W);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#fff2b0';
    ctx.lineWidth = S * 0.02;
    for (let j = 0; j <= 6; j++) {
      const a = o.a - FLARE_W + (j / 6) * FLARE_W * 2;
      const len = S * (0.06 + 0.07 * (0.5 + 0.5 * Math.sin(this.time * 25 + j * 1.7)));
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * (r - len * 0.6), Math.sin(a) * (r - len * 0.6));
      ctx.lineTo(Math.cos(a) * (r + len), Math.sin(a) * (r + len));
      ctx.stroke();
    }
  }

  private drawBeam(ctx: CanvasRenderingContext2D, o: Obj, S: number, k: number): void {
    const lr = this.laneR(o.lane);
    const r0 = (lr - 0.1) * S;
    const r1 = (lr + 0.1) * S;
    const c = Math.cos(o.a);
    const sn = Math.sin(o.a);
    ctx.lineCap = 'round';
    if (!o.armed) {
      const pulse = 0.4 + 0.4 * Math.sin(this.time * 14);
      ctx.strokeStyle = `rgba(255, 93, 93, ${pulse * k})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(c * r0, sn * r0);
      ctx.lineTo(c * r1, sn * r1);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(c * lr * S, sn * lr * S, S * 0.045, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    // Firing: a laser from the UFO plus the hot beam across the orbit.
    if (this.boss && this.boss.kind === 'ufo') {
      const u = this.ufoPos();
      const ux = u.x * S;
      const uy = u.y * S;
      ctx.strokeStyle = 'rgba(255, 93, 93, 0.45)';
      ctx.lineWidth = S * 0.012;
      ctx.beginPath();
      ctx.moveTo(ux, uy);
      ctx.lineTo(c * lr * S, sn * lr * S);
      ctx.stroke();
    }
    ctx.save();
    ctx.shadowColor = '#ff3b3b';
    ctx.shadowBlur = S * 0.08;
    ctx.strokeStyle = '#ff5d5d';
    ctx.lineWidth = S * 0.05;
    ctx.beginPath();
    ctx.moveTo(c * r0, sn * r0);
    ctx.lineTo(c * r1, sn * r1);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = S * 0.016;
    ctx.beginPath();
    ctx.moveTo(c * r0, sn * r0);
    ctx.lineTo(c * r1, sn * r1);
    ctx.stroke();
  }

  private drawGate(ctx: CanvasRenderingContext2D, x: number, y: number, S: number, k: number): void {
    const r = GATE_R * S * 1.25 * k;
    ctx.save();
    ctx.translate(x, y);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.8);
    g.addColorStop(0, 'rgba(125, 249, 255, 0.55)');
    g.addColorStop(0.5, 'rgba(182, 107, 255, 0.3)');
    g.addColorStop(1, 'rgba(182, 107, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.rotate(this.time * 3);
    ctx.lineWidth = Math.max(2, S * 0.014);
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = ['#7df9ff', '#b36bff', '#ffffff'][i];
      ctx.beginPath();
      ctx.arc(0, 0, r * (1 - i * 0.25), i * 2, i * 2 + Math.PI * 1.3);
      ctx.stroke();
    }
    ctx.restore();
    const pulse = 0.6 + 0.4 * Math.sin(this.time * 6);
    ctx.globalAlpha = pulse;
    text(ctx, 'WARP', x, y - r * 2.1, S * 0.07, '#7df9ff', 900);
    ctx.globalAlpha = 1;
  }

  private drawBoss(ctx: CanvasRenderingContext2D, b: Boss, S: number): void {
    if (b.kind === 'worm') {
      for (let i = WORM_SEGS - 1; i >= 0; i--) {
        const sp = this.wormSegPos(b, i);
        const r = (i === 0 ? 0.08 : 0.065 - i * 0.002) * S;
        ctx.fillStyle = i === 0 ? '#c88bff' : i % 2 ? '#8a4be0' : '#a466f0';
        ctx.beginPath();
        ctx.arc(sp.x * S, sp.y * S, r, 0, Math.PI * 2);
        ctx.fill();
        if (i > 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.beginPath();
          ctx.arc(sp.x * S - r * 0.3, sp.y * S - r * 0.3, r * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Face: eyes looking along its direction of travel.
      const hd = this.wormSegPos(b, 0);
      const dir = b.headA - Math.PI / 2;
      for (const side of [-1, 1]) {
        const ex = hd.x * S + Math.cos(dir) * S * 0.03 + Math.cos(b.headA) * side * S * 0.03;
        const ey = hd.y * S + Math.sin(dir) * S * 0.03 + Math.sin(b.headA) * side * S * 0.03;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(ex, ey, S * 0.022, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1a0b2e';
        ctx.beginPath();
        ctx.arc(ex + Math.cos(dir) * S * 0.008, ey + Math.sin(dir) * S * 0.008, S * 0.011, 0, Math.PI * 2);
        ctx.fill();
      }
      // Warning as it closes in.
      if (wrap(b.headA - this.angle) < (this.speed + WORM_SPEED) * 1.0) {
        const pulse = 0.5 + 0.5 * Math.sin(this.time * 14);
        ctx.globalAlpha = pulse;
        const rr = b.segR[0] + 0.16;
        text(ctx, '!', Math.cos(b.headA) * rr * S, Math.sin(b.headA) * rr * S, S * 0.1, '#ff5d5d', 900);
        ctx.globalAlpha = 1;
      }
    } else {
      const u = this.ufoPos();
      const x = u.x * S;
      const y = u.y * S;
      const r = S * 0.13;
      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = 'rgba(125, 249, 255, 0.8)';
      ctx.beginPath();
      ctx.ellipse(0, -r * 0.2, r * 0.45, r * 0.4, 0, Math.PI, 0);
      ctx.fill();
      const g = ctx.createLinearGradient(0, -r * 0.3, 0, r * 0.3);
      g.addColorStop(0, '#e8e8f5');
      g.addColorStop(1, '#6d6d8a');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, 0, r, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      for (let i = 0; i < 5; i++) {
        const on = Math.floor(this.time * 8 + i) % 2 === 0;
        ctx.fillStyle = on ? '#ff5d5d' : '#ffd166';
        ctx.beginPath();
        ctx.arc((-0.6 + i * 0.3) * r, r * 0.08, r * 0.07, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawGalaxy(ctx: CanvasRenderingContext2D, btns: Btn[]): void {
    const { cx, base } = this;
    const p = this.profile;
    const top = this.safe.top + 36;
    text(ctx, 'GALAXY', cx, top, base * 0.065, '#ffffff', 900);
    this.wallet(ctx, this.w - this.safe.right - 16, top);

    const pending = pendingGems(p);
    const ca = btns.find((b) => b.id === 'collectAll')!;
    roundRect(ctx, ca.x, ca.y, ca.w, ca.h, ca.h / 2);
    ctx.fillStyle = pending > 0 ? '#ffd166' : 'rgba(255,255,255,0.1)';
    ctx.fill();
    text(ctx, pending > 0 ? `COLLECT ALL  +${pending}` : 'STATIONS PRODUCING…', cx, ca.y + ca.h / 2 + 1, 16, pending > 0 ? '#0b0d1f' : 'rgba(255,255,255,0.6)', 900);

    const { nodes, panel } = this.galaxyLayout();
    // The route between planets.
    ctx.setLineDash([5, 7]);
    ctx.lineDashOffset = -this.time * 10;
    ctx.lineWidth = 2;
    for (let i = 1; i < nodes.length; i++) {
      ctx.strokeStyle = p.discovered.includes(i) ? 'rgba(125, 249, 255, 0.45)' : 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(nodes[i - 1].x, nodes[i - 1].y);
      ctx.lineTo(nodes[i].x, nodes[i].y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    nodes.forEach((n, i) => {
      const found = p.discovered.includes(i);
      const st = p.stations[i];
      if (i === this.selectedPlanet) {
        ctx.strokeStyle = '#7df9ff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * 1.35 + Math.sin(this.time * 4) * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (found) {
        ctx.save();
        ctx.translate(n.x, n.y);
        this.drawPlanet(ctx, n.r / 0.3, PLANETS[i]);
        ctx.restore();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
        text(ctx, '?', n.x, n.y + 1, n.r, 'rgba(255,255,255,0.35)', 900);
      }
      if (st) {
        // Station: a small satellite on the planet's shoulder, with a fill bar.
        const sx = n.x + n.r * 0.85;
        const sy = n.y - n.r * 0.85;
        ctx.fillStyle = '#d9dcf0';
        ctx.fillRect(sx - 5, sy - 3, 10, 6);
        ctx.fillStyle = '#7df9ff';
        ctx.fillRect(sx - 13, sy - 2, 7, 4);
        ctx.fillRect(sx + 6, sy - 2, 7, 4);
        const frac = st.stored / stationCap(i, st.level);
        progressBar(ctx, n.x - n.r, n.y + n.r + 22, n.r * 2, 5, frac, frac >= 1 ? '#ff8a8a' : '#ffd166');
        if (frac >= 1) text(ctx, 'FULL', n.x + n.r + 18, n.y + n.r + 24, 10, '#ff8a8a', 900);
      }
      text(ctx, found ? PLANETS[i].name : '???', n.x, n.y + n.r + 11, 12, found ? '#ffffff' : 'rgba(255,255,255,0.4)', 800);
    });

    // Detail panel for the selected planet.
    const i = this.selectedPlanet;
    const pl = PLANETS[i];
    const st = p.stations[i];
    roundRect(ctx, panel.x, panel.y, panel.w, panel.h, 18);
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const px = panel.x + 18;
    if (!p.discovered.includes(i)) {
      text(ctx, 'UNKNOWN PLANET', px, panel.y + 30, 17, '#ffffff', 900, 'left');
      text(ctx, 'Reach this planet in a run to discover it.', px, panel.y + 58, 13, 'rgba(255,255,255,0.7)', 600, 'left');
      text(ctx, 'Then build a station here to earn gems.', px, panel.y + 78, 13, 'rgba(255,255,255,0.7)', 600, 'left');
    } else if (!st) {
      const info = STATION_INFO[i];
      text(ctx, pl.name.toUpperCase(), px, panel.y + 30, 17, '#ffffff', 900, 'left');
      text(ctx, `Build a station to earn ${stationRate(i, 1)} gems/hour,`, px, panel.y + 58, 13, 'rgba(255,255,255,0.75)', 600, 'left');
      text(ctx, `even while you're not playing.`, px, panel.y + 77, 13, 'rgba(255,255,255,0.75)', 600, 'left');
      const b = btns.find((x) => x.id === 'build')!;
      button(ctx, b, `BUILD STATION · ${info.build}`, p.gems >= info.build);
    } else {
      const rate = stationRate(i, st.level);
      const cap = stationCap(i, st.level);
      text(ctx, `${pl.name.toUpperCase()} STATION`, px, panel.y + 26, 16, '#ffffff', 900, 'left');
      text(ctx, `LV ${st.level}`, panel.x + panel.w - 18, panel.y + 26, 16, '#7df9ff', 900, 'right');
      text(ctx, `${rate} gems/hour · holds ${cap} (${Math.round(cap / rate)} h)`, px, panel.y + 50, 13, 'rgba(255,255,255,0.7)', 600, 'left');
      progressBar(ctx, px, panel.y + 66, panel.w - 36, 10, st.stored / cap, st.stored >= cap ? '#ff8a8a' : '#ffd166');
      text(ctx, `${Math.floor(st.stored)} / ${cap}`, panel.x + panel.w - 18, panel.y + 90, 12, 'rgba(255,255,255,0.6)', 700, 'right');
      const c = btns.find((x) => x.id === 'collectOne')!;
      button(ctx, c, `COLLECT ${Math.floor(st.stored)}`, Math.floor(st.stored) > 0);
      const u = btns.find((x) => x.id === 'upgradeStation')!;
      if (st.level >= MAX_STATION_LEVEL) button(ctx, u, 'MAX LEVEL', false);
      else button(ctx, u, `UPGRADE · ${upgradeCost(i, st.level)}`, false);
    }
  }

  private drawHangar(ctx: CanvasRenderingContext2D, btns: Btn[]): void {
    const { cx, base } = this;
    const p = this.profile;
    const top = this.safe.top + 36;
    text(ctx, 'HANGAR', cx, top, base * 0.065, '#ffffff', 900);
    this.wallet(ctx, this.w - this.safe.right - 16, top);
    text(ctx, 'Permanent upgrades for every run', cx, this.safe.top + 80, base * 0.038, 'rgba(255,255,255,0.65)', 600);
    const width = Math.min(this.w - 32, 460);
    const left = (this.w - width) / 2;
    UPGRADES.forEach((u) => {
      const b = btns.find((x) => x.id === `upg:${u.id}`)!;
      const rowH = Math.min(92, (this.h - this.safe.bottom - 20 - (this.safe.top + 110)) / UPGRADES.length);
      const ry = b.y + b.h / 2 - (rowH - 8) / 2;
      const lvl = upgradeLevel(p, u.id);
      const maxed = lvl >= u.costs.length;
      roundRect(ctx, left, ry, width, rowH - 8, 14);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fill();
      text(ctx, u.name, left + 14, ry + 20, 15, '#ffffff', 900, 'left');
      // Description, wrapped to two lines if needed.
      ctx.font = `600 12px ${FONT}`;
      const maxW = width - 140;
      const words = u.desc.split(' ');
      const lines: string[] = [''];
      for (const wd of words) {
        const t = lines[lines.length - 1] ? lines[lines.length - 1] + ' ' + wd : wd;
        if (ctx.measureText(t).width > maxW && lines[lines.length - 1]) lines.push(wd);
        else lines[lines.length - 1] = t;
      }
      lines.slice(0, 2).forEach((ln, k) => text(ctx, ln, left + 14, ry + 40 + k * 15, 12, 'rgba(255,255,255,0.65)', 600, 'left'));
      // Level pips.
      for (let k = 0; k < u.costs.length; k++) {
        ctx.fillStyle = k < lvl ? '#7df9ff' : 'rgba(255,255,255,0.15)';
        roundRect(ctx, left + 14 + k * 18, ry + rowH - 18, 14, 4, 2);
        ctx.fill();
      }
      if (maxed) {
        text(ctx, lvl > 1 || u.costs.length > 1 ? 'MAXED' : 'OWNED', b.x + b.w / 2, b.y + b.h / 2, 14, '#7dff6b', 900);
      } else {
        roundRect(ctx, b.x, b.y, b.w, b.h, b.h / 2);
        ctx.fillStyle = p.gems >= u.costs[lvl] ? '#ffd166' : 'rgba(255,255,255,0.1)';
        ctx.fill();
        gemAmount(ctx, String(u.costs[lvl]), b.x + b.w / 2, b.y + b.h / 2 + 1, 16, p.gems >= u.costs[lvl] ? '#0b0d1f' : 'rgba(255, 209, 102, 0.6)');
      }
    });
  }

  private drawModal(ctx: CanvasRenderingContext2D): void {
    const m = this.modals[0];
    const r = this.modalRect();
    this.dim(ctx, 0.7);
    roundRect(ctx, r.x, r.y, r.w, r.h, 22);
    const g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    g.addColorStop(0, '#2a1d63');
    g.addColorStop(1, '#151033');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(125, 249, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();
    const cx = r.x + r.w / 2;
    const btns = this.modalButtons();
    if (m.kind === 'daily') {
      text(ctx, 'DAILY REWARD', cx, r.y + 40, 24, '#ffffff', 900);
      text(ctx, m.day === 1 && this.profile.daily.streak > 0 ? 'Streak reset: come back every day!' : `Day ${m.day} of 7 · come back tomorrow for more`, cx, r.y + 68, 13, 'rgba(255,255,255,0.7)', 600);
      // Seven day tiles.
      const tw = (r.w - 36 - 6 * 6) / 7;
      DAILY_REWARDS.forEach((amt, k) => {
        const x = r.x + 18 + k * (tw + 6);
        const y = r.y + 96;
        const day = k + 1;
        const past = day < m.day;
        const today = day === m.day;
        roundRect(ctx, x, y, tw, 74, 10);
        ctx.fillStyle = today ? '#ffd166' : past ? 'rgba(125, 255, 107, 0.2)' : 'rgba(255,255,255,0.08)';
        ctx.fill();
        text(ctx, `D${day}`, x + tw / 2, y + 14, 11, today ? '#0b0d1f' : 'rgba(255,255,255,0.6)', 800);
        if (past) text(ctx, '✓', x + tw / 2, y + 40, 18, '#7dff6b', 900);
        else gemIcon(ctx, x + tw / 2, y + 38, day === 7 ? 11 : 8);
        text(ctx, String(amt), x + tw / 2, y + 61, 11, today ? '#0b0d1f' : '#ffd166', 900);
      });
      text(ctx, `+${DAILY_REWARDS[m.day - 1]} gems`, cx, r.y + 205, 22, '#ffd166', 900);
      button(ctx, btns[0], 'CLAIM', true);
    } else {
      text(ctx, 'WELCOME BACK!', cx, r.y + 40, 24, '#ffffff', 900);
      text(ctx, 'Your stations kept working while you were away', cx, r.y + 70, 13, 'rgba(255,255,255,0.7)', 600);
      gemAmount(ctx, String(m.gems), cx, r.y + 130, 44);
      const c = btns.find((b) => b.id === 'collectWelcome')!;
      const d = btns.find((b) => b.id === 'collectWelcome2x');
      if (d) this.adButton(ctx, d, `COLLECT x2 (+${m.gems * 2})`);
      button(ctx, c, `COLLECT ${m.gems}`, !d);
    }
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
    if (this.lanes.length > 2 && this.phase !== 'warp') {
      // Arrow showing which way the next tap moves (in or out).
      const dirA = Math.atan2(p.y, p.x);
      const out = this.laneDir > 0 ? 1 : -1;
      const base = this.radius + out * 0.1;
      const tip = this.radius + out * 0.17;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.beginPath();
      ctx.moveTo(Math.cos(dirA) * tip * S, Math.sin(dirA) * tip * S);
      ctx.lineTo(Math.cos(dirA + 0.05) * base * S, Math.sin(dirA + 0.05) * base * S);
      ctx.lineTo(Math.cos(dirA - 0.05) * base * S, Math.sin(dirA - 0.05) * base * S);
      ctx.closePath();
      ctx.fill();
    }
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
    const btns = this.screenButtons();
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
      case 'galaxy':
        this.dim(ctx, 0.85);
        this.drawGalaxy(ctx, btns);
        break;
      case 'hangar':
        this.dim(ctx, 0.85);
        this.drawHangar(ctx, btns);
        break;
    }
    if (this.state === 'shop' || this.state === 'missions' || this.state === 'galaxy' || this.state === 'hangar') this.iconButton(ctx, btn('back')!, 'back');
    if (this.modalOpen) this.drawModal(ctx);

    // Toasts sit just above the orbit.
    if (this.toast.life > 0) {
      const a = Math.min(1, this.toast.life * 3);
      const y =
        this.state === 'shop' || this.state === 'hangar' || this.state === 'galaxy'
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

    // Pilot rank.
    const p = this.profile;
    const rankY = titleY + base * 0.15;
    text(ctx, `PILOT RANK ${p.rank}`, cx, rankY, base * 0.034, '#7df9ff', 800);
    progressBar(ctx, cx - 70, rankY + 11, 140, 5, p.xp / xpToNext(p.rank), '#7df9ff');

    const pulse = 0.55 + 0.45 * Math.sin(this.time * 4);
    const galaxy = btn('galaxy')!;
    const playY = (this.cy + this.scale + galaxy.y) / 2;
    if (galaxy.y - (this.cy + this.scale) > 34) text(ctx, 'TAP TO PLAY', cx, playY, base * 0.05, `rgba(255,255,255,${pulse})`, 800);

    button(ctx, galaxy, 'GALAXY', false);
    button(ctx, btn('hangar')!, 'HANGAR', false);
    button(ctx, btn('shop')!, 'SHOP', false);
    button(ctx, btn('missions')!, 'MISSIONS', false);
    // Badge: gems waiting in the stations.
    const pending = pendingGems(p);
    if (pending > 0) {
      const label = `+${pending}`;
      ctx.font = `900 12px ${FONT}`;
      const bw = ctx.measureText(label).width + 16;
      roundRect(ctx, galaxy.x + galaxy.w - bw + 6, galaxy.y - 8, bw, 20, 10);
      ctx.fillStyle = '#ffd166';
      ctx.fill();
      text(ctx, label, galaxy.x + galaxy.w - bw / 2 + 6, galaxy.y + 2, 12, '#0b0d1f', 900);
    }
  }

  private drawPlayHud(ctx: CanvasRenderingContext2D, btn: (id: string) => Btn | undefined): void {
    const { cx, base } = this;
    const top = this.safe.top + 36;
    this.iconButton(ctx, btn('pause') ?? { id: 'pause', x: this.safe.left + 14, y: this.safe.top + 14, w: 44, h: 44 }, 'pause');
    this.drawJourney(ctx, top);

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
      const a = Math.min(1, this.banner.life * 2);
      const y = this.safe.top + 100;
      ctx.globalAlpha = a;
      const warn = this.banner.title === 'WARNING!';
      const size = base * Math.min(0.08, 0.9 / Math.max(8, this.banner.title.length));
      text(ctx, this.banner.title, cx, y, warn ? size * (1 + 0.08 * Math.sin(this.time * 12)) : size, warn ? '#ff5d5d' : '#7df9ff', 900);
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

  /** Top-of-screen progress: planet progress, boss health, or warp. */
  private drawJourney(ctx: CanvasRenderingContext2D, top: number): void {
    const { cx, base } = this;
    const bw = Math.min(150, base * 0.36);
    let label = '';
    let frac = 0;
    let color = '#7df9ff';
    switch (this.phase) {
      case 'stage':
        label = `${this.stats.planets}. ${this.planet.name.toUpperCase()}`;
        frac = this.stageFrac();
        break;
      case 'gate':
        label = 'WARP GATE AHEAD';
        frac = 1;
        color = `rgba(125, 249, 255, ${0.5 + 0.5 * Math.sin(this.time * 6)})`;
        break;
      case 'bossIntro':
      case 'boss': {
        const info = BOSSES[this.planet.boss!];
        label = info.name;
        frac = this.boss ? 1 - this.boss.t / BOSS_DUR : 1;
        color = info.color;
        break;
      }
      case 'warp':
        label = 'WARP';
        frac = this.phaseT / WARP_DUR;
        text(ctx, String(this.score), cx, top + 46, base * 0.1, this.timers.double > 0 ? '#ffd166' : '#ffffff', 900);
        break;
    }
    text(ctx, label, cx, top - 6, base * 0.036, 'rgba(255,255,255,0.75)', 800);
    progressBar(ctx, cx - bw / 2, top + 8, bw, 6, frac, color);
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
    if (this.finalized) {
      y += base * 0.07;
      const pr = this.profile;
      const extra = this.discoveries.length ? `  ·  NEW: ${this.discoveries.join(', ').toUpperCase()}` : '';
      text(ctx, `+${this.runXp} XP · RANK ${pr.rank}${extra}`, cx, y, base * 0.036, '#7df9ff', 800);
      progressBar(ctx, cx - 70, y + 11, 140, 5, pr.xp / xpToNext(pr.rank), '#7df9ff');
    }

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
