// Everything that persists between sessions, stored as one JSON blob.
import { loadValue, saveValue } from './native';

export interface MissionState {
  type: string;
  target: number;
  progress: number;
  reward: number;
  done: boolean;
}

export interface Profile {
  best: number;
  gems: number; // spendable wallet
  gamesPlayed: number;
  owned: string[];
  skin: string;
  sound: boolean;
  missionLevel: number;
  missions: MissionState[];
  tutorialDone: boolean;
}

const KEY = 'orbitdash.profile';
const LEGACY_BEST = 'orbitdash.best';
const LEGACY_SOUND = 'orbitdash.sound';

export function defaultProfile(): Profile {
  return {
    best: 0,
    gems: 0,
    gamesPlayed: 0,
    owned: ['classic'],
    skin: 'classic',
    sound: true,
    missionLevel: 0,
    missions: [],
    tutorialDone: false,
  };
}

export async function loadProfile(): Promise<Profile> {
  const p = defaultProfile();
  const raw = await loadValue(KEY);
  if (raw) {
    try {
      Object.assign(p, JSON.parse(raw));
    } catch {
      /* corrupted save: start fresh */
    }
    return p;
  }
  // Migrate saves from version 1.0.
  const best = await loadValue(LEGACY_BEST);
  if (best) {
    p.best = parseInt(best, 10) || 0;
    p.tutorialDone = p.best > 0;
  }
  p.sound = (await loadValue(LEGACY_SOUND)) !== '0';
  return p;
}

export function saveProfile(p: Profile): void {
  void saveValue(KEY, JSON.stringify(p));
}
