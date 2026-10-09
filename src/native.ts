// Thin wrappers around Capacitor plugins. Every call is safe on the web
// (where the plugins are unavailable or no-ops), so the game runs in a browser too.
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

export const isNative = Capacitor.isNativePlatform();

export async function initNative(): Promise<void> {
  if (!isNative) return;
  try {
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.hide();
  } catch {
    /* status bar not available on this platform */
  }
  try {
    await SplashScreen.hide();
  } catch {
    /* ignore */
  }
}

let hapticsOn = true;
export function setHaptics(on: boolean): void {
  hapticsOn = on;
}

export function tapHaptic(): void {
  if (!isNative || !hapticsOn) return;
  void Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}

export function gemHaptic(): void {
  if (!isNative || !hapticsOn) return;
  void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => {});
}

export function crashHaptic(): void {
  if (!isNative || !hapticsOn) return;
  void Haptics.notification({ type: NotificationType.Error }).catch(() => {});
}

export async function loadValue(key: string): Promise<string | null> {
  try {
    const { value } = await Preferences.get({ key });
    return value;
  } catch {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
}

export async function saveValue(key: string, value: string): Promise<void> {
  try {
    await Preferences.set({ key, value });
  } catch {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  }
}

/** Calls onPause/onResume when the app is backgrounded/foregrounded. */
export function onLifecycle(onPause: () => void, onResume: () => void): void {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onPause();
    else onResume();
  });
  if (isNative) {
    void App.addListener('appStateChange', ({ isActive }) => (isActive ? onResume() : onPause()));
  }
}

/** Android hardware back button. Return true from the handler if it was consumed. */
export function onBackButton(handler: () => boolean): void {
  if (!isNative) return;
  void App.addListener('backButton', () => {
    if (!handler()) void App.exitApp();
  });
}

// ------------------------------------------------------------------ reminders

const STATIONS_FULL_ID = 1;
const DAILY_ID = 2;

/** Asks for permission to send reminders (call after the player has seen why). */
export async function askNotificationPermission(): Promise<void> {
  if (!isNative) return;
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display === 'prompt' || display === 'prompt-with-rationale') await LocalNotifications.requestPermissions();
  } catch {
    /* ignore */
  }
}

/**
 * Re-schedules the two reminders: when the stations fill up, and the daily
 * reward the next evening. Called whenever the app goes to the background.
 */
export async function scheduleReminders(opts: { stationsFullAt: number | null; fullGems: number; dailyDay: number; streak: number }): Promise<void> {
  if (!isNative) return;
  try {
    const { display } = await LocalNotifications.checkPermissions();
    if (display !== 'granted') return;
    await LocalNotifications.cancel({ notifications: [{ id: STATIONS_FULL_ID }, { id: DAILY_ID }] });
    const notifications = [];
    const now = Date.now();
    if (opts.stationsFullAt && opts.stationsFullAt > now + 30 * 60_000) {
      notifications.push({
        id: STATIONS_FULL_ID,
        title: 'Your stations are full! 🛰️',
        body: `${opts.fullGems} gems are waiting for you. Collect them before production stops.`,
        schedule: { at: new Date(opts.stationsFullAt) },
      });
    }
    // Tomorrow at 6 pm local time.
    const d = new Date();
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 18, 0, 0);
    notifications.push({
      id: DAILY_ID,
      title: `Day ${opts.dailyDay} reward is ready 🎁`,
      body: opts.streak > 1 ? `Keep your ${opts.streak}-day streak going!` : 'Come back for free gems and keep your streak alive.',
      schedule: { at },
    });
    await LocalNotifications.schedule({ notifications });
  } catch (e) {
    console.warn('Reminders unavailable', e);
  }
}
