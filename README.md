# Orbit Dash

A one-tap arcade game for iOS and Android. Your ship orbits a planet. **Tap to jump between the inner and outer orbit**, hop between six planets through warp gates, survive boss fights, grab gems and power-ups, complete missions and unlock new ships.

Built with **TypeScript + HTML5 Canvas** (no game engine and no image or audio files: all graphics are drawn in code and all sounds are synthesized) and packaged as native apps with **[Capacitor](https://capacitorjs.com)**.

## Features

- One-tap controls with haptic feedback on native devices
- **Power-ups:** Shield (absorbs one hit), Magnet (pulls in gems from both orbits), Slow-Mo, Double Points
- **Combo multiplier** up to x5 for chaining gems, plus **close-call** bonuses for last-second dodges
- **Comets** that fly at you, with a warning marker where they'll cross your path
- **Planet hopping:** each planet ends with a **warp gate**; flying through it starts a short **warp flight** (dodge debris left/right) to the next planet. The ship gets faster on every planet, and the six planets loop.
  | Planet | Twist |
  |---|---|
  | Home | Classic rocks |
  | Lava World | Solar flares: wide hazards that glow as a warning, then erupt as you pass |
  | Ice World | Slippery, slower orbit switching. **Boss: Space Worm** |
  | Gas Giant | Three orbits; each tap bounces one orbit in or out (arrow shows the direction) |
  | Black Hole | Orbits shrink as you go; rocks drift towards you |
  | Pulsar | Comet storm. **Boss: Laser UFO** |
- **Bosses** (20 s each, survive to win +10 gems): the **Space Worm** circles against you and only changes orbit on the far side of the planet, so it's always dodgeable; the **Laser UFO** fires beams across one orbit, each marked by a dashed red line first
- **Missions** (3 at a time, getting harder) that reward gems
- **Skins shop:** spend gems on 6 ships with unique trails
- First-run tutorial hint, sound toggle, pause, auto-pause in the background, Android back button
- **Ads (Google AdMob):** optional rewarded ads to *continue a run* (once per run) or *double your gems*, plus a full-screen ad between games (at most every 3rd game, never in a player's first 3 games, at least 90 s apart)
- **Remove Ads** one-time purchase ($1.99) with Restore Purchases; the consent popup (EU/UK) and iOS tracking prompt are handled
- Progress saved on device. Plays offline (ads just don't show).

Website, privacy policy and support pages are in `docs/`. Store listing text and graphics are in `store/`.

## Project layout

```
src/
  main.ts      canvas setup, game loop, input
  game.ts      gameplay, rendering, HUD and menus
  content.ts   skins, zone themes, power-ups, missions
  profile.ts   saved progress (best, gems, skins, missions)
  ui.ts        canvas drawing helpers (buttons, icons, bars)
  monetize.ts  AdMob ads + Remove Ads purchase (ad IDs live here)
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

Every push builds the Android app (a downloadable debug APK under **Actions → Build → Artifacts**) and checks that the iOS app compiles.

---

# Launch guide

Ready-made store assets:
- `store/LISTING.md`: every store field filled in (name, descriptions, keywords, categories, age rating and data-safety answers), ready to copy and paste
- `store/screenshots/`: screenshots at the exact required sizes for iPhone 6.9", iPad 13" and Android phones
- `store/graphics/`: Play Store 512px icon, 1024×500 feature graphic, App Store 1024px icon
- `docs/`: website with the privacy policy and support pages both stores require

App ID (permanent): **`com.abdullahalsaid.orbitdash`**

## Step 1: Publish the website (5 min, free)

1. Merge this branch into `main`.
2. Make sure the repo is **public** (Settings → General → Danger Zone → Change visibility).
3. Settings → **Pages** → *Build and deployment* → Source: **Deploy from a branch** → Branch: `main`, folder: **`/docs`** → Save.
4. After a minute these URLs will be live:
   - https://abdullahalsaid56-ai.github.io/game1/privacy.html
   - https://abdullahalsaid56-ai.github.io/game1/support.html

The support page sends people to GitHub Issues, so make sure Issues is enabled (Settings → General → Features).

## Step 2: Create the developer accounts

| | Google Play | Apple App Store |
|---|---|---|
| Sign up | https://play.google.com/console/signup | https://developer.apple.com/programs/enroll/ |
| Cost | $25 once | $99 per year |
| Needs | Google account, ID verification, a phone number. Choose a **Personal** account unless you have a registered business. | Apple ID with two-factor authentication, ID verification (easiest in the **Apple Developer app** on an iPhone). |
| Approval time | A few hours to a few days | Usually 1–2 days |

## Step 3: Google Play

Install **[Android Studio](https://developer.android.com/studio)** (free, runs on Windows, Mac and Linux) and **[Node.js 22](https://nodejs.org)**.

```bash
git clone https://github.com/abdullahalsaid56-ai/game1.git
cd game1
npm install
npm run android        # builds the game and opens it in Android Studio
```

1. **Test on your phone (optional):** turn on USB debugging on your Android phone, plug it in, and press ▶ Run in Android Studio. You can also install the APK from **GitHub → Actions → Build → latest run → Artifacts**.
2. **Build the release:** *Build → Generate Signed App Bundle or APK → Android App Bundle → Create new…* keystore.
   **Back up the `.jks` file and its passwords somewhere safe** (e.g. a password manager). Don't commit it to git. You'll need it for every update.
3. Choose the **release** build variant. The file appears at `android/app/release/app-release.aab`.
4. In Play Console: **Create app** → fill in **Store listing** and **App content** from `store/LISTING.md`, then upload the screenshots and graphics.
5. **Testing → Closed testing → Create track**, upload the `.aab`, and add **at least 12 testers** (friends' Gmail addresses). New personal accounts must keep 12+ testers opted in for **14 days** before they can apply for production.
6. After the 14 days: **Apply for production access** → once approved, create a Production release with the same `.aab` → **Send for review**.

## Step 4: Apple App Store

Building an iOS app requires **Xcode, which only runs on macOS**. Your options:

- **Borrow a Mac or use one at a library or school.** You only need it for about an hour per release.
- **Rent a cloud Mac**, e.g. MacinCloud or AWS EC2 Mac.
- **Build in the cloud without a Mac:** [Codemagic](https://codemagic.io) supports Capacitor and has a free tier. It can build, sign and upload to App Store Connect using an App Store Connect API key.

With a Mac:

```bash
git clone https://github.com/abdullahalsaid56-ai/game1.git
cd game1
npm install
npm run ios            # builds the game and opens Xcode
```

1. In Xcode select the **App** target → **Signing & Capabilities** → check *Automatically manage signing* → pick your Team. The bundle ID is already `com.abdullahalsaid.orbitdash`.
2. Plug in your iPhone and press ▶ to test it on the device.
3. In [App Store Connect](https://appstoreconnect.apple.com) → **Apps → + → New App**: platform iOS, name, language, bundle ID `com.abdullahalsaid.orbitdash`, SKU `orbitdash001`.
4. In Xcode choose **Any iOS Device (arm64)** → **Product → Archive** → **Distribute App → App Store Connect → Upload**.
5. In App Store Connect fill in everything from `store/LISTING.md`, upload the `iphone-6.9-*` and `ipad-13-*` screenshots, set **App Privacy → Data Not Collected**, select the uploaded build → **Add for Review** → **Submit**.
6. Review usually takes 1–3 days. If you're rejected, the message explains why, and most fixes are small.

> Apple occasionally rejects very simple games under guideline 4.2 (minimum functionality). If that happens, adding Game Center leaderboards is the usual fix.

## Ads and in-app purchases: switching to real ads

The game ships with **Google's test ads**, which are safe to tap during development. Never tap your own real ads, because AdMob can ban your account for it. In `npm run dev`, the browser shows a simulated "TEST AD" screen instead.

Before releasing:

1. **Create an AdMob account** at https://admob.google.com (free), and add a payment method so you can get paid.
2. **Add two apps** in AdMob (Apps → Add app): one Android, one iOS. You can link them to the store listings later, once they're published.
3. In each app, **create two ad units**: *Interstitial* and *Rewarded* (reward amount 1, item "continue").
4. Put the IDs into the project:
   - `src/monetize.ts`: replace the four ad unit IDs in `AD_UNITS` and set `USE_TEST_ADS = false`
   - `android/app/src/main/res/values/strings.xml`: `admob_app_id` → your **Android app ID** (contains a `~`)
   - `ios/App/App/Info.plist`: `GADApplicationIdentifier` → your **iOS app ID**
5. **Privacy & messaging** (AdMob → Privacy & messaging): create a **GDPR message** for the EEA/UK and an **IDFA explainer** for iOS. The game already shows them; AdMob decides when.
6. **app-ads.txt:** AdMob verifies you own the app through a file at the root of the developer website in your store listing. Create a public GitHub repo named exactly `abdullahalsaid56-ai.github.io`, add a file `app-ads.txt` containing the line AdMob shows you (like `google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0`), and enable Pages on it. Then use `https://abdullahalsaid56-ai.github.io` as the developer website in both stores.
7. **Create the `remove_ads` product** in Play Console and App Store Connect. Step-by-step instructions are in `store/LISTING.md`.
8. Fill in the **Data safety** (Play) and **App Privacy** (Apple) forms with the AdMob answers in `store/LISTING.md`.

To test real purchases without paying: on Android, add your Gmail under Play Console → Settings → **License testing**; on iOS, use a **Sandbox** tester (App Store Connect → Users and Access → Sandbox).

## Releasing updates

1. Change the code, then run `npm run sync`.
2. Android: increase `versionCode` (e.g. 1 → 2) and `versionName` in `android/app/build.gradle`, build a new signed bundle **with the same keystore**, and upload it.
3. iOS: increase *Version* and *Build* in Xcode (App target → General), then archive and upload.

## Regenerating store screenshots

Run `npm run dev` and open the page in Chrome DevTools device mode at the target size (e.g. 430×932 at 3× for iPhone 6.9"), play, and capture the screen with DevTools' *Capture screenshot*.

## Ideas for next versions

- Leaderboards (Game Center / Google Play Games)
- Unlockable ship skins bought with gems
- Rewarded ads or a one-time "remove ads" purchase for monetization (requires updating the privacy policy and data-safety forms)
