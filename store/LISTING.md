# Store listing — copy & paste

Everything you need to fill in on App Store Connect and Google Play Console. All text has been checked against each field's character limit.

**Website (after you enable GitHub Pages; see the README)**
- Marketing URL: https://abdullahalsaid56-ai.github.io/game1/
- Privacy Policy URL: https://abdullahalsaid56-ai.github.io/game1/privacy.html
- Support URL: https://abdullahalsaid56-ai.github.io/game1/support.html

---

## Shared text

**App name** (30 max): `Orbit Dash: Tap to Survive`
If that name is taken, try `Orbit Dash – Space Arcade` or `Orbit Dash`.

**Full description** (4000 max):

```
One tap. Two orbits. How long can you survive?

Your ship races around a glowing planet. Tap anywhere to jump between orbits, dodge everything in your path, and fly through the warp gate to the next world. How far across the galaxy can you get?

Simple to learn, hard to master. It's perfect for a quick break.

FEATURES
• One-tap controls: play with a single thumb
• Planet hopping: warp between 6 worlds, each with its own twist: erupting solar flares on Lava World, slippery orbits on Ice World, three orbits around the Gas Giant, shrinking orbits at the Black Hole, and a comet storm at the Pulsar
• Build your galaxy: claim every planet you reach and build space stations that earn gems even while you're away
• Hangar upgrades: make your ship permanently stronger
• Daily rewards and a 7-day streak, plus pilot ranks to climb
• Boss fights: outlast the Space Worm and the Laser UFO for big rewards
• Warp flights: dodge debris as you race between planets
• Power-ups: Shield, Gem Magnet, Slow-Mo and Double Points
• Combo multiplier up to x5: chain gems to multiply every point
• Close-call bonuses for last-second dodges
• Missions that reward you with gems
• Unlock six ship skins with unique trails
• Satisfying haptics and retro sound effects
• Works offline, so you can play anywhere
• No account needed, plus an optional one-time Remove Ads purchase

Can you make it past the Pulsar?
```

---

## Apple App Store (App Store Connect)

| Field | Value |
|---|---|
| Name | Orbit Dash: Tap to Survive |
| Subtitle (30) | One-tap space arcade dodger |
| Bundle ID | com.abdullahalsaid.orbitdash |
| SKU | orbitdash001 |
| Primary category | Games → Arcade |
| Secondary category | Games → Casual |
| Price | Free |
| Keywords (100) | `arcade,one tap,space,planet,galaxy,dodge,reflex,casual,endless,offline,hyper casual,gems` |
| Promotional text (170) | Hop between 6 planets, beat the bosses and build a galaxy of stations that earn gems even while you're away. All with one tap! |
| Copyright | 2026 Abdullah Alsaid |

**Screenshots** (in `store/screenshots/`):
- iPhone 6.9" display → `iphone-6.9-*.png` (1290 × 2796)
- iPad 13" display → `ipad-13-*.png` (2064 × 2752)

**App icon:** taken from the build automatically. `store/graphics/app-store-icon-1024.png` is there if you're asked for it.

**In-app purchase** (Features → In-App Purchases → +):
- Type: **Non-Consumable**
- Reference name: `Remove Ads`, Product ID: **`remove_ads`** (must match exactly)
- Price: $1.99 (Tier 2 or the price you choose)
- Display name: `Remove Ads`, Description: `Removes all ads between games.`
- Add a screenshot of the Shop screen (`store/screenshots/iphone-6.9-6-shop.png`) for review
- You must accept the **Paid Apps Agreement** (Business section) and add bank/tax info before in-app purchases work

**App Privacy** (because of Google AdMob). Check these against Google's current guide: https://developers.google.com/admob/ios/privacy/data-disclosure
| Data type | Used for | Linked to user? | Used for tracking? |
|---|---|---|---|
| Identifiers → Device ID | Third-Party Advertising, Analytics | No | **Yes** |
| Usage Data → Product Interaction | Third-Party Advertising, Analytics | No | No |
| Usage Data → Advertising Data | Third-Party Advertising, Analytics | No | No |
| Diagnostics → Crash Data, Performance Data, Other Diagnostic Data | Analytics | No | No |
| Location → Coarse Location | Third-Party Advertising, Analytics | No | No |

**Age rating questionnaire:** answer **None / No** to everything. For *Advertising*, answer **Yes** (contains ads). Expected rating: **4+**.

**Export compliance:** already answered in the app (`ITSAppUsesNonExemptEncryption = NO`), so you won't be asked.

**App Review notes** (optional):
> Single-tap arcade game. Tap anywhere to switch orbit. No login required.

---

## Google Play (Play Console)

| Field | Value |
|---|---|
| App name (30) | Orbit Dash: Tap to Survive |
| Short description (80) | Tap to switch orbits, dodge rocks and grab gems. How long can you survive? |
| Package name | com.abdullahalsaid.orbitdash |
| App or game | Game |
| Category | Arcade |
| Free or paid | Free |
| Tags | Arcade, Casual, Space, Offline |

**Graphics** (in `store/graphics/` and `store/screenshots/`):
- App icon: `play-icon-512.png` (512 × 512)
- Feature graphic: `play-feature-graphic-1024x500.png`
- Phone screenshots: `android-phone-*.png` (1080 × 1920)
- 7" and 10" tablet screenshots (optional): you can upload the `ipad-13-*.png` files

**App content** section:
| Form | Answer |
|---|---|
| Privacy policy | https://abdullahalsaid56-ai.github.io/game1/privacy.html |
| Ads | **Yes**, my app contains ads |
| App access | All functionality is available without special access |
| Content rating (IARC) | Category: Game. Answer **No** to violence, fear, sexuality, gambling, language, drugs, user interaction and sharing location. Answer **Yes** to *digital purchases* (Remove Ads). Expected rating: **Everyone / PEGI 3** |
| Target audience | **13–15, 16–17, 18+ only**. Do not select any age under 13: the ads are not set up for the Families policy |
| Data safety | See the table below |
| Government app / Financial features / Health | No / None / No |

**In-app product** (Monetize → Products → In-app products → Create product):
- Product ID: **`remove_ads`** (must match exactly)
- Name: `Remove Ads`, Description: `Removes all ads between games.`, Price: $1.99
- Activate it. You need a **payments profile** (Settings → Payments profile) before you can create products, and the app must have been uploaded at least once (closed testing is fine).

**Data safety** (because of Google AdMob). Check these against Google's current guide: https://developers.google.com/admob/android/privacy/play-data-disclosure
- Does your app collect or share any of the required user data types? **Yes**
- Is all user data encrypted in transit? **Yes**
- Do you provide a way for users to request that their data be deleted? **No** (the game stores no data on servers; ad data is handled by Google)

| Data type | Collected | Shared | Purpose |
|---|---|---|---|
| Location → Approximate location (from IP address) | Yes | Yes | Advertising or marketing, Analytics, Fraud prevention |
| App activity → App interactions | Yes | Yes | Advertising or marketing, Analytics, Fraud prevention |
| App info and performance → Crash logs, Diagnostics | Yes | Yes | Analytics, Fraud prevention |
| Device or other IDs → Device or other IDs (advertising ID) | Yes | Yes | Advertising or marketing, Analytics, Fraud prevention |

For each type: processed ephemerally? **No**. Required or optional? **Required** (ads are how the free game is funded).

**Advertising ID declaration** (App content → Advertising ID): **Yes**, the app uses an advertising ID, for **Advertising or marketing** and **Analytics**.

