# Orbit Dash

A one-tap arcade game for iOS and Android. Your ship orbits a planet. **Tap to jump between the inner and outer orbit**, dodge the red rocks and grab the gold gems. The ship speeds up every 20 points.

Built with **TypeScript + HTML5 Canvas** (no game engine and no image or audio files: all graphics are drawn in code and all sounds are synthesized) and packaged as native apps with **[Capacitor](https://capacitorjs.com)**.

## Features

- One-tap controls with haptic feedback on native devices
- Difficulty ramps up with speed levels and obstacle patterns (single rocks, gem arcs, zig-zags)
- Best score saved on device
- Sound toggle, pause button, auto-pause when the app goes to the background, Android back button support
- Handles notches and safe areas, scales to any phone or tablet
- Works offline. No ads, no tracking, no network access.

## Project layout

```
src/
  main.ts      canvas setup, game loop, input
  game.ts      gameplay, rendering, HUD
  audio.ts     synthesized sound effects (Web Audio)
  native.ts    Capacitor plugins: haptics, storage, status bar, lifecycle
assets/        source icon and splash images (used to generate native assets)
android/       native Android project (open in Android Studio)
ios/           native iOS project (open in Xcode)
capacitor.config.ts
```

## Run it locally

```bash
npm install
npm run dev        # open the printed URL on your computer or phone (same Wi-Fi)
```

Keyboard: Space/Enter/arrow keys to switch orbit, Esc or P to pause.

## Build the native apps

```bash
npm run android    # builds the web bundle, syncs it, opens Android Studio
npm run ios        # same, opens Xcode (requires macOS)
```

Run `npm run sync` after every change to `src/` so the native projects get the new bundle.

After changing `assets/icon-only.png` or `assets/splash.png`, run `npm run assets` to regenerate every icon and splash size.

Every push builds an Android debug APK in GitHub Actions (**Actions → Build → Artifacts**). You can install it on an Android phone to test.

---

# Launch checklist

### 0. Before anything else

1. **Pick your app ID.** Change `appId` in `capacitor.config.ts` from `com.orbitdash.game` to a reverse domain you control, e.g. `com.yourname.orbitdash`. Also change `applicationId` in `android/app/build.gradle` (leave `namespace` as it is) and the bundle identifier in Xcode (App target → Signing & Capabilities). **You can't change it after the first release.**
2. Check that the name "Orbit Dash" isn't already taken in both stores. If it is, change `appName` in `capacitor.config.ts` and the display name in Xcode and `android/app/src/main/res/values/strings.xml`.
3. Host `PRIVACY.md` somewhere public (e.g. enable GitHub Pages, or paste it into a free site). Both stores ask for a privacy policy URL.

### 1. Google Play (Android)

You'll need a [Google Play Console](https://play.google.com/console) developer account ($25 one-time fee) and [Android Studio](https://developer.android.com/studio).

1. `npm run android` → Android Studio opens.
2. **Build → Generate Signed App Bundle / APK → Android App Bundle**. Create a new upload keystore when asked. **Back up the keystore file and its passwords.** You need them for every future update.
3. The release `.aab` is written to `android/app/release/`.
4. In Play Console: **Create app** → fill in the store listing (description, screenshots, feature graphic 1024×500, icon 512×512) → complete the **App content** forms:
   - Privacy policy: your hosted `PRIVACY.md` URL
   - Ads: **No**
   - Data safety: **No data collected or shared**
   - Content rating questionnaire: likely rated *Everyone / PEGI 3*
   - Target audience: 13+ is simplest. Selecting under-13 triggers the stricter Families policy.
5. New personal developer accounts must run a **closed test with at least 12 testers for 14 days** before production access. Upload the `.aab` to the Closed testing track first.
6. For each update, increase `versionCode` (and `versionName`) in `android/app/build.gradle`.

### 2. Apple App Store (iOS)

You'll need a Mac with Xcode, and an [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/year).

1. `npm run ios` → Xcode opens.
2. Select the **App** target → **Signing & Capabilities** → choose your Team and set your Bundle Identifier.
3. In [App Store Connect](https://appstoreconnect.apple.com): **My Apps → + → New App** with the same bundle ID.
4. In Xcode choose **Any iOS Device (arm64)** → **Product → Archive** → **Distribute App → App Store Connect → Upload**.
5. In App Store Connect add screenshots (6.9" iPhone at minimum; 13" iPad if you keep iPad support), a description, keywords, support URL and privacy policy URL. Set **App Privacy** to *Data Not Collected*, then answer the age rating questions (likely 4+).
6. Optionally test with TestFlight first, then **Submit for Review**.
7. For each update, increase *Version* and *Build* in the App target's General tab.

> Apple sometimes rejects very simple games under guideline 4.2 (minimum functionality). The game's polish, haptics and progression help. Adding Game Center leaderboards (e.g. with the `@capacitor-community/game-center` plugin, or a similar one) makes approval even more likely and helps players stick around.

### Screenshots

Run `npm run dev`, open the page in Chrome DevTools device mode at the required size (e.g. 1290×2796 for iPhone 6.9"), play a bit, and capture the screen. Or take them on a real device or simulator.

## Ideas for next versions

- Leaderboards (Game Center / Google Play Games)
- Unlockable ship skins bought with gems
- Rewarded ads or a one-time "remove ads" purchase for monetization (requires updating the privacy policy and data-safety forms)
