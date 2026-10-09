// Ads (Google AdMob) and the "Remove Ads" in-app purchase.
//
// BEFORE RELEASE: replace the TEST IDs below with your own from
// admob.google.com, set USE_TEST_ADS to false, and replace the AdMob app IDs
// in android/app/src/main/res/values/strings.xml and ios/App/App/Info.plist.
// See "Ads and in-app purchases" in the README.
import { AdMob, AdmobConsentStatus } from '@capacitor-community/admob';
import { Capacitor } from '@capacitor/core';
import { NativePurchases, PURCHASE_TYPE, type Transaction } from '@capgo/native-purchases';

const USE_TEST_ADS = true;

const AD_UNITS = {
  android: {
    interstitial: 'ca-app-pub-3940256099942544/1033173712', // Google test ID
    rewarded: 'ca-app-pub-3940256099942544/5224354917', // Google test ID
  },
  ios: {
    interstitial: 'ca-app-pub-3940256099942544/4411468910', // Google test ID
    rewarded: 'ca-app-pub-3940256099942544/1712485313', // Google test ID
  },
};

/** Product ID of the one-time "Remove Ads" purchase, created in Play Console / App Store Connect. */
export const REMOVE_ADS_ID = 'remove_ads';

// Interstitial pacing: never in a player's first games, and never too often.
const INTERSTITIAL_MIN_GAMES = 3;
const INTERSTITIAL_EVERY = 3; // games between interstitials
const INTERSTITIAL_MIN_SECONDS = 90;

const platform = Capacitor.getPlatform();
const native = platform === 'ios' || platform === 'android';
// In `npm run dev` the browser simulates ads so the flow can be tested without a phone.
const simulate = !native && import.meta.env.DEV;
const units = platform === 'ios' ? AD_UNITS.ios : AD_UNITS.android;

type Listener = () => void;

class Monetization {
  private ready = false;
  private rewardedLoaded = false;
  private interstitialLoaded = false;
  private gamesSinceAd = 0;
  private lastAdAt = 0;
  private privacyRequired = false;

  adsRemoved = false;
  removeAdsPrice = '';
  /** Called whenever an ad opens/closes, so the game can mute and pause. */
  onAdOpen: Listener = () => {};
  onAdClose: Listener = () => {};
  /** Shows the simulated ad overlay in dev builds. */
  onSimulatedAd: (kind: 'rewarded' | 'interstitial', done: () => void) => void = (_k, done) => done();

  async init(adsRemoved: boolean): Promise<void> {
    this.adsRemoved = adsRemoved;
    if (simulate) {
      this.ready = this.rewardedLoaded = this.interstitialLoaded = true;
      this.removeAdsPrice = '$1.99';
      return;
    }
    if (!native) return;
    void this.initPurchases();
    try {
      let consent = await AdMob.requestConsentInfo();
      if (consent.isConsentFormAvailable && consent.status === AdmobConsentStatus.REQUIRED) {
        consent = await AdMob.showConsentForm();
      }
      this.privacyRequired = String(consent.privacyOptionsRequirementStatus) === 'REQUIRED';
      if (!consent.canRequestAds) return;
      if (platform === 'ios') {
        const { status } = await AdMob.trackingAuthorizationStatus();
        if (status === 'notDetermined') await AdMob.requestTrackingAuthorization();
      }
      await AdMob.initialize({ initializeForTesting: USE_TEST_ADS });
      this.ready = true;
      void this.loadRewarded();
      if (!this.adsRemoved) void this.loadInterstitial();
    } catch (e) {
      console.warn('Ads unavailable', e);
    }
  }

  /** Whether the "privacy options" entry point must be shown (GDPR regions). */
  get showPrivacyOptions(): boolean {
    return this.privacyRequired;
  }

  async openPrivacyOptions(): Promise<void> {
    if (native) await AdMob.showPrivacyOptionsForm().catch(() => {});
  }

  // ---------------------------------------------------------------- rewarded

  get rewardedReady(): boolean {
    return this.ready && this.rewardedLoaded;
  }

  private async loadRewarded(): Promise<void> {
    if (!native || !this.ready) return;
    try {
      await AdMob.prepareRewardVideoAd({ adId: units.rewarded, isTesting: USE_TEST_ADS });
      this.rewardedLoaded = true;
    } catch {
      this.rewardedLoaded = false;
      setTimeout(() => void this.loadRewarded(), 30000);
    }
  }

  /** Shows a rewarded ad. Resolves true only if the player earned the reward. */
  async showRewarded(): Promise<boolean> {
    if (!this.rewardedReady) return false;
    this.lastAdAt = Date.now();
    this.gamesSinceAd = 0;
    if (simulate) return new Promise((resolve) => this.onSimulatedAd('rewarded', () => resolve(true)));
    this.rewardedLoaded = false;
    this.onAdOpen();
    try {
      const reward = await AdMob.showRewardVideoAd();
      return !!reward;
    } catch {
      return false;
    } finally {
      this.onAdClose();
      void this.loadRewarded();
    }
  }

  // ---------------------------------------------------------------- interstitial

  private async loadInterstitial(): Promise<void> {
    if (!native || !this.ready || this.adsRemoved) return;
    try {
      await AdMob.prepareInterstitial({ adId: units.interstitial, isTesting: USE_TEST_ADS });
      this.interstitialLoaded = true;
    } catch {
      this.interstitialLoaded = false;
      setTimeout(() => void this.loadInterstitial(), 30000);
    }
  }

  /** Call after each finished game; shows an interstitial when pacing allows. */
  async afterGame(gamesPlayed: number): Promise<void> {
    this.gamesSinceAd++;
    if (this.adsRemoved || !this.ready || !this.interstitialLoaded) return;
    if (gamesPlayed < INTERSTITIAL_MIN_GAMES || this.gamesSinceAd < INTERSTITIAL_EVERY) return;
    if (Date.now() - this.lastAdAt < INTERSTITIAL_MIN_SECONDS * 1000) return;
    this.lastAdAt = Date.now();
    this.gamesSinceAd = 0;
    if (simulate) return new Promise((resolve) => this.onSimulatedAd('interstitial', resolve));
    this.interstitialLoaded = false;
    this.onAdOpen();
    try {
      await AdMob.showInterstitial();
    } catch {
      /* ignore */
    } finally {
      this.onAdClose();
      void this.loadInterstitial();
    }
  }

  // ---------------------------------------------------------------- purchases

  private async initPurchases(): Promise<void> {
    try {
      const { isBillingSupported } = await NativePurchases.isBillingSupported();
      if (!isBillingSupported) return;
      const { product } = await NativePurchases.getProduct({ productIdentifier: REMOVE_ADS_ID, productType: PURCHASE_TYPE.INAPP });
      this.removeAdsPrice = product.priceString;
      // Re-check ownership on every launch (covers reinstalls and refunds of pending purchases).
      const { purchases } = await NativePurchases.getPurchases({ productType: PURCHASE_TYPE.INAPP });
      if (purchases.some((t) => this.ownsRemoveAds(t))) this.setAdsRemoved();
    } catch (e) {
      console.warn('Purchases unavailable', e);
    }
  }

  private ownsRemoveAds(t: Transaction): boolean {
    if (t.productIdentifier !== REMOVE_ADS_ID) return false;
    // On Android only a completed purchase ("1") counts; pending ones don't.
    return platform !== 'android' || t.purchaseState === undefined || t.purchaseState === '1';
  }

  /** Called when ownership changes; the game persists it. */
  onAdsRemoved: Listener = () => {};

  private setAdsRemoved(): void {
    if (this.adsRemoved) return;
    this.adsRemoved = true;
    this.interstitialLoaded = false;
    this.onAdsRemoved();
  }

  get canBuy(): boolean {
    return !this.adsRemoved && this.removeAdsPrice !== '';
  }

  async buyRemoveAds(): Promise<boolean> {
    if (simulate) {
      this.setAdsRemoved();
      return true;
    }
    try {
      const t = await NativePurchases.purchaseProduct({ productIdentifier: REMOVE_ADS_ID, productType: PURCHASE_TYPE.INAPP });
      if (this.ownsRemoveAds(t)) {
        this.setAdsRemoved();
        return true;
      }
    } catch (e) {
      console.warn('Purchase failed or cancelled', e);
    }
    return false;
  }

  /** "Restore purchases" (required by Apple). Resolves true if Remove Ads was found. */
  async restore(): Promise<boolean> {
    if (simulate) return this.adsRemoved;
    try {
      await NativePurchases.restorePurchases();
      const { purchases } = await NativePurchases.getPurchases({ productType: PURCHASE_TYPE.INAPP });
      if (purchases.some((t) => this.ownsRemoveAds(t))) this.setAdsRemoved();
    } catch (e) {
      console.warn('Restore failed', e);
    }
    return this.adsRemoved;
  }

  /** Purchases are available on this device (always true in dev simulation). */
  get storeAvailable(): boolean {
    return simulate || (native && this.removeAdsPrice !== '');
  }
}

export const money = new Monetization();
