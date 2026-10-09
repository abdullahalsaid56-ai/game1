// Static game content: ship skins, zone themes, power-ups and missions.
import type { MissionState } from './profile';

// ------------------------------------------------------------------ skins

export interface Skin {
  id: string;
  name: string;
  price: number;
  body: string;
  glow: string;
  trail: string[]; // trail colours, cycled along the trail
  rainbow?: boolean;
}

export const SKINS: Skin[] = [
  { id: 'classic', name: 'Comet', price: 0, body: '#ffffff', glow: '#7df9ff', trail: ['#7df9ff'] },
  { id: 'ember', name: 'Ember', price: 60, body: '#fff1d6', glow: '#ff8a3d', trail: ['#ff8a3d', '#ffd166'] },
  { id: 'toxic', name: 'Toxic', price: 150, body: '#efffd6', glow: '#7dff6b', trail: ['#7dff6b', '#c6ff4a'] },
  { id: 'royal', name: 'Royal', price: 300, body: '#fff6d6', glow: '#ffd166', trail: ['#b69cff', '#ffd166'] },
  { id: 'ghost', name: 'Phantom', price: 500, body: '#e9e6ff', glow: '#b69cff', trail: ['#ffffff', '#b69cff', '#7df9ff'] },
  { id: 'rainbow', name: 'Prism', price: 900, body: '#ffffff', glow: '#ff6bd6', trail: [], rainbow: true },
];

export function skinById(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

// ------------------------------------------------------------------ zones

export interface Theme {
  name: string;
  bgTop: string;
  bgBottom: string;
  planet: [string, string, string]; // highlight, mid, edge
  glow: string; // rgb triple for rgba()
}

export const THEMES: Theme[] = [
  { name: 'Violet Drift', bgTop: '#0b0d1f', bgBottom: '#1a1040', planet: ['#b69cff', '#6a4bd8', '#2a1a6e'], glow: '124, 92, 255' },
  { name: 'Teal Nebula', bgTop: '#06141c', bgBottom: '#0b3140', planet: ['#9ff7ea', '#2bb3a3', '#0d4a52'], glow: '43, 179, 163' },
  { name: 'Crimson Belt', bgTop: '#1a070d', bgBottom: '#3d0f1d', planet: ['#ffb3a7', '#e0475a', '#5c1426'], glow: '224, 71, 90' },
  { name: 'Solar Gate', bgTop: '#1a1206', bgBottom: '#3d2a0b', planet: ['#fff0a8', '#f2a93b', '#6b3a0d'], glow: '242, 169, 59' },
  { name: 'Event Horizon', bgTop: '#050508', bgBottom: '#1a1024', planet: ['#000000', '#000000', '#000000'], glow: '255, 150, 60' },
  { name: 'Pink Pulsar', bgTop: '#170616', bgBottom: '#3b0d3a', planet: ['#ffc2f2', '#e04fc2', '#560f4b'], glow: '224, 79, 194' },
];

// ------------------------------------------------------------------ planets

/** What makes each planet play differently. */
export type Twist = 'none' | 'flares' | 'ice' | 'three' | 'drift' | 'comets';
export type PlanetStyle = 'rocky' | 'lava' | 'ice' | 'gas' | 'blackhole' | 'pulsar';
export type BossKind = 'worm' | 'ufo';

export interface Planet {
  name: string;
  theme: Theme;
  twist: Twist;
  style: PlanetStyle;
  hint: string;
  boss?: BossKind; // fought at the end of this planet, before the warp gate
}

export const PLANETS: Planet[] = [
  { name: 'Home', theme: THEMES[0], twist: 'none', style: 'rocky', hint: 'Reach the warp gate!' },
  { name: 'Lava World', theme: THEMES[2], twist: 'flares', style: 'lava', hint: 'Solar flares erupt as you pass' },
  { name: 'Ice World', theme: THEMES[1], twist: 'ice', style: 'ice', hint: 'Slippery orbits: switch early', boss: 'worm' },
  { name: 'Gas Giant', theme: THEMES[3], twist: 'three', style: 'gas', hint: 'Three orbits: taps bounce in and out' },
  { name: 'Black Hole', theme: THEMES[4], twist: 'drift', style: 'blackhole', hint: 'Orbits shrink, rocks drift in' },
  { name: 'Pulsar', theme: THEMES[5], twist: 'comets', style: 'pulsar', hint: 'Comet storm!', boss: 'ufo' },
];

export const BOSSES: Record<BossKind, { name: string; color: string }> = {
  worm: { name: 'SPACE WORM', color: '#b36bff' },
  ufo: { name: 'LASER UFO', color: '#ff5d5d' },
};

// ------------------------------------------------------------------ power-ups

export type PowerKind = 'shield' | 'magnet' | 'slow' | 'double';

export const POWERS: Record<PowerKind, { name: string; color: string; duration: number }> = {
  shield: { name: 'SHIELD', color: '#7df9ff', duration: 0 }, // lasts until hit
  magnet: { name: 'MAGNET', color: '#ff6bd6', duration: 7 },
  slow: { name: 'SLOW-MO', color: '#8fb3ff', duration: 5 },
  double: { name: 'DOUBLE POINTS', color: '#ffd166', duration: 8 },
};

export const POWER_KINDS = Object.keys(POWERS) as PowerKind[];

// ------------------------------------------------------------------ missions

/** Stats gathered during a single run, used to update missions. */
export interface RunStats {
  score: number;
  gems: number;
  dodges: number;
  powerups: number;
  shieldSaves: number;
  maxMultiplier: number;
  comets: number;
  planets: number; // planets reached this run (starts at 1)
  bosses: number;
}

interface MissionDef {
  type: string;
  perRun: boolean; // true: must be achieved in one run; false: cumulative
  describe: (n: number) => string;
  target: (level: number) => number;
  stat: (s: RunStats) => number;
}

const MISSION_DEFS: MissionDef[] = [
  { type: 'score', perRun: true, describe: (n) => `Score ${n} in one run`, target: (l) => 30 + l * 15, stat: (s) => s.score },
  { type: 'gemsRun', perRun: true, describe: (n) => `Grab ${n} gems in one run`, target: (l) => 6 + l * 3, stat: (s) => s.gems },
  { type: 'gemsTotal', perRun: false, describe: (n) => `Collect ${n} gems`, target: (l) => 40 + l * 25, stat: (s) => s.gems },
  { type: 'dodges', perRun: false, describe: (n) => `Make ${n} close calls`, target: (l) => 8 + l * 5, stat: (s) => s.dodges },
  { type: 'powerups', perRun: false, describe: (n) => `Pick up ${n} power-ups`, target: (l) => 4 + l * 2, stat: (s) => s.powerups },
  { type: 'shield', perRun: false, describe: (n) => `Survive ${n} hits with a shield`, target: (l) => 2 + l, stat: (s) => s.shieldSaves },
  { type: 'multiplier', perRun: true, describe: (n) => `Reach a x${n} multiplier`, target: (l) => Math.min(5, 3 + Math.floor(l / 2)), stat: (s) => s.maxMultiplier },
  { type: 'comets', perRun: false, describe: (n) => `Dodge ${n} comets`, target: (l) => 5 + l * 3, stat: (s) => s.comets },
  { type: 'planets', perRun: true, describe: (n) => `Reach planet ${n} in one run`, target: (l) => Math.min(9, 2 + Math.ceil(l / 2)), stat: (s) => s.planets },
  { type: 'bosses', perRun: false, describe: (n) => (n === 1 ? 'Defeat a boss' : `Defeat ${n} bosses`), target: (l) => 1 + Math.floor(l / 3), stat: (s) => s.bosses },
];

function defOf(type: string): MissionDef {
  return MISSION_DEFS.find((d) => d.type === type) ?? MISSION_DEFS[0];
}

export function describeMission(m: MissionState): string {
  return defOf(m.type).describe(m.target);
}

export function newMission(level: number, exclude: string[]): MissionState {
  const pool = MISSION_DEFS.filter((d) => !exclude.includes(d.type));
  const d = pool[Math.floor(Math.random() * pool.length)];
  return { type: d.type, target: d.target(level), progress: 0, reward: 20 + level * 10, done: false };
}

/**
 * Applies live run stats to missions. Per-run missions track the best value
 * this run; cumulative missions add to what was banked before the run.
 * `banked` holds each cumulative mission's progress at the start of the run.
 * Returns missions that just became complete.
 */
export function updateMissions(missions: MissionState[], stats: RunStats, banked: number[]): MissionState[] {
  const completed: MissionState[] = [];
  missions.forEach((m, i) => {
    if (m.done) return;
    const d = defOf(m.type);
    const value = d.stat(stats);
    m.progress = Math.min(m.target, d.perRun ? Math.max(m.progress, value) : banked[i] + value);
    if (m.progress >= m.target) {
      m.done = true;
      completed.push(m);
    }
  });
  return completed;
}
