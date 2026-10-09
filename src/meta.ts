// The long-term game: galaxy stations (idle income), hangar upgrades,
// daily login streak and pilot rank. Pure logic on the saved profile.
import type { RunStats } from './content';
import type { Profile } from './profile';

// ------------------------------------------------------------------ stations

export interface Station {
  level: number;
  stored: number; // gems waiting to be collected (fractional)
  last: number; // timestamp (ms) of the last production tick
}

/** Per planet (same order as PLANETS): cost to build and gems/hour at level 1. */
export const STATION_INFO = [
  { build: 0, base: 6 },
  { build: 60, base: 9 },
  { build: 140, base: 12 },
  { build: 260, base: 16 },
  { build: 420, base: 21 },
  { build: 650, base: 27 },
];
export const MAX_STATION_LEVEL = 10;
export const STORAGE_HOURS = 8;

export function stationRate(planet: number, level: number): number {
  return STATION_INFO[planet].base * level;
}

export function stationCap(planet: number, level: number): number {
  return Math.round(stationRate(planet, level) * STORAGE_HOURS);
}

export function upgradeCost(planet: number, level: number): number {
  const base = STATION_INFO[planet].build || 40;
  return Math.round(base * 0.8 * Math.pow(1.55, level));
}

/** Adds production since the last tick to every station. */
export function tickStations(p: Profile, now = Date.now()): void {
  for (const [key, s] of Object.entries(p.stations)) {
    const i = Number(key);
    const hours = Math.max(0, now - s.last) / 3_600_000;
    s.stored = Math.min(stationCap(i, s.level), s.stored + stationRate(i, s.level) * hours);
    s.last = now;
  }
}

export function pendingGems(p: Profile): number {
  return Object.values(p.stations).reduce((n, s) => n + Math.floor(s.stored), 0);
}

export function collect(p: Profile, planet: number): number {
  const s = p.stations[planet];
  if (!s) return 0;
  const n = Math.floor(s.stored);
  s.stored -= n;
  p.gems += n;
  return n;
}

export function collectAll(p: Profile): number {
  let n = 0;
  for (const key of Object.keys(p.stations)) n += collect(p, Number(key));
  return n;
}

/** Timestamp when the first not-yet-full station fills up, or null. */
export function nextFullAt(p: Profile, now = Date.now()): number | null {
  let best: number | null = null;
  for (const [key, s] of Object.entries(p.stations)) {
    const i = Number(key);
    const missing = stationCap(i, s.level) - s.stored;
    if (missing <= 0) continue;
    const at = now + (missing / stationRate(i, s.level)) * 3_600_000;
    if (best === null || at < best) best = at;
  }
  return best;
}

export function buildStation(p: Profile, planet: number): boolean {
  const cost = STATION_INFO[planet].build;
  if (p.stations[planet] || !p.discovered.includes(planet) || p.gems < cost) return false;
  p.gems -= cost;
  p.stations[planet] = { level: 1, stored: 0, last: Date.now() };
  return true;
}

export function upgradeStation(p: Profile, planet: number): boolean {
  const s = p.stations[planet];
  if (!s || s.level >= MAX_STATION_LEVEL) return false;
  const cost = upgradeCost(planet, s.level);
  if (p.gems < cost) return false;
  tickStations(p);
  p.gems -= cost;
  s.level++;
  return true;
}

// ------------------------------------------------------------------ hangar upgrades

export type UpgradeId = 'shieldStart' | 'magnet' | 'luck' | 'gemBonus' | 'comboSaver';

export const UPGRADES: { id: UpgradeId; name: string; desc: string; costs: number[] }[] = [
  { id: 'shieldStart', name: 'Starter Shield', desc: 'Begin every run with a shield', costs: [250] },
  { id: 'magnet', name: 'Stronger Magnet', desc: 'Magnet lasts 1.5 s longer per level', costs: [40, 90, 180, 320, 550] },
  { id: 'luck', name: 'Lucky Finds', desc: '20% more power-ups per level', costs: [50, 110, 220, 400, 700] },
  { id: 'gemBonus', name: 'Gem Polisher', desc: '+10% chance per level to get double gems', costs: [60, 130, 260, 450, 750] },
  { id: 'comboSaver', name: 'Combo Saver', desc: 'Keep your multiplier after a missed gem (1x per level per run)', costs: [120, 300, 600] },
];

export function upgradeLevel(p: Profile, id: UpgradeId): number {
  return p.upgrades[id] ?? 0;
}

export function buyUpgrade(p: Profile, id: UpgradeId): boolean {
  const u = UPGRADES.find((x) => x.id === id)!;
  const lvl = upgradeLevel(p, id);
  if (lvl >= u.costs.length || p.gems < u.costs[lvl]) return false;
  p.gems -= u.costs[lvl];
  p.upgrades[id] = lvl + 1;
  return true;
}

// ------------------------------------------------------------------ daily streak

export const DAILY_REWARDS = [20, 30, 45, 60, 80, 110, 200];

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The day (1-7) of the reward available today, or 0 if already claimed. */
export function dailyAvailable(p: Profile, now = new Date()): number {
  const today = dayKey(now);
  if (p.daily.lastClaim === today) return 0;
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const continuing = p.daily.lastClaim === yesterday;
  return continuing ? (p.daily.streak % 7) + 1 : 1;
}

export function claimDaily(p: Profile, now = new Date()): number {
  const day = dailyAvailable(p, now);
  if (!day) return 0;
  const reward = DAILY_REWARDS[day - 1];
  p.daily = { streak: day === 1 ? 1 : p.daily.streak + 1, lastClaim: dayKey(now) };
  p.gems += reward;
  return reward;
}

// ------------------------------------------------------------------ pilot rank

export function xpForRun(s: RunStats): number {
  return Math.round(s.score / 10 + (s.planets - 1) * 15 + s.bosses * 40 + s.gems);
}

/** XP needed to go from `rank` to `rank + 1`. */
export function xpToNext(rank: number): number {
  return Math.round(60 * Math.pow(rank, 1.6));
}

export function rankReward(rank: number): number {
  return 30 + rank * 10;
}

/** Adds XP; returns the ranks reached (each pays rankReward). */
export function addXp(p: Profile, xp: number): number[] {
  p.xp += xp;
  const reached: number[] = [];
  while (p.xp >= xpToNext(p.rank)) {
    p.xp -= xpToNext(p.rank);
    p.rank++;
    p.gems += rankReward(p.rank);
    reached.push(p.rank);
  }
  return reached;
}
