# Google Play release kit

Everything the Play Console asks for, ready to paste or upload. The Android app is the web app
(`web/`) packaged with Capacitor (`web/android/`).

## Build

```sh
cd web
npm run android:apk      # debug APK for a phone: android/app/build/outputs/apk/debug/app-debug.apk
npm run android:bundle   # signed release bundle for Play: android/app/build/outputs/bundle/release/app-release.aab
```

Needs `JAVA_HOME` (Java 21) and `ANDROID_HOME` (Android SDK, API 36). Release builds are signed with the
upload key named in `~/.gradle/gradle.properties` (`BACKGAMMON_UPLOAD_*`); the key itself lives in
`~/.android-signing/` and is **never** committed. Back up the keystore and its password: Google can
reset a lost upload key, but only after a support request and a wait.

Before each new upload, raise `versionCode` (and `versionName`) in `web/android/app/build.gradle`.

## Store listing

**App name** (30 max): `Backgammon: Play & Analyse`

**Short description** (80 max):
`Play backgammon against the GNU Backgammon engine and review every move. No ads.`

**Full description:**

```
Play backgammon against one of the strongest backgammon programs, then see exactly where you went wrong.

This app runs GNU Backgammon (gnubg) itself, the open-source engine used by serious players for decades, compiled to run entirely on your phone. Everything works offline.

PLAY
• Matches to any length, or money games with the Jacoby and beaver rules
• Five strength levels, from beginner to world class
• Two players on one phone, or online with a friend: send a link and play from two devices
• Light and dark themes, several board colours

LEARN
• Hints: gnubg's ranked moves with win, gammon and backgammon chances, shown on the board
• A tutor that warns you before you play a mistake (optional)
• Cube advice: when to double, take or pass

REVIEW
• Every game analysed by gnubg when it ends: error rates, luck, and your biggest mistakes
• A full review of the match, move by move: the move you played against gnubg's best, with the equity you lost
• Win-chance graph over the game, with errors and lucky rolls marked
• Open and save match files (.sgf and Jellyfish .mat)

FREE AND OPEN
No ads, no accounts, no tracking. The app is free software under the GNU GPL v3; the source code is on GitHub. If you enjoy it, there is an optional tip jar. Tips don't unlock anything.

GNU Backgammon is developed by the gnubg team as part of the GNU Project. This app is an independent port and is not affiliated with or endorsed by them.
```

**Category:** Games › Board · **Tags:** backgammon, board game · **Contact email:** required by Google
(shown publicly; consider a dedicated address) · **Website:** https://backgammon-blond.vercel.app ·
**Privacy policy:** https://backgammon-blond.vercel.app/privacy

**Graphics** (this folder):
- App icon 512×512: `play-icon-512.png`
- Feature graphic 1024×500: `feature-graphic-1024x500.png`
- Phone screenshots 1080×1920: `screenshots/1-…5-…png`

## In-app products (Monetize › Products › In-app products)

Create three **one-time, consumable** products with these exact IDs (they are in `web/src/lib/tips.ts`), then activate them:

| Product ID   | Name        | Description                          | Suggested price |
|--------------|-------------|--------------------------------------|-----------------|
| `tip_small`  | Small tip   | A small thank-you. Unlocks nothing.  | 1.99            |
| `tip_medium` | Medium tip  | A bigger thank-you. Unlocks nothing. | 4.99            |
| `tip_large`  | Large tip   | A big thank-you. Unlocks nothing.    | 9.99            |

Products can only be created after an app bundle that includes the billing library has been
uploaded (any track, e.g. internal testing), and the account needs a payments (merchant) profile.

## App content answers

- **Ads:** No ads.
- **App access:** All functionality is available without special access.
- **Target audience:** 13+ (not designed for children; avoids the Families policy).
- **Content rating (IARC questionnaire):** Category "Game". No violence, sexuality, language, drugs.
  Gambling: **no** real-money gambling or simulated gambling (it is a board game with dice; there are no
  bets, chips or casino mechanics). Users can interact/exchange info: **yes, limited** (online games with
  a friend via a link; only a typed name and the moves are shared; no chat). Digital purchases: yes (tips).
- **Data safety:**
  - Data collected: **Name** (the name a player types for an online game; optional, purpose "App
    functionality", not linked to identity, deleted after a week). **App activity › Other actions**
    (the moves of an online game, same purposes). Nothing else.
  - **Tips:** payments go through Google Play Billing. Follow the form's own guidance on whether
    billing data counts as collected by the app (the app itself stores nothing about purchases).
  - Data is encrypted in transit: **yes** (HTTPS). Users can request deletion: **yes** (via GitHub issues;
    games also expire after a week). No data shared with third parties; no data sold.
- **Government app / financial features / health:** No.
- **News app:** No.

## Release plan (new personal account)

1. **Internal testing:** upload `app-release.aab`, add yourself as tester, install from the Play link,
   check the tip jar with a test card (license testers buy for free: Settings › License testing).
2. **Closed testing:** at least **12 testers opted in for 14 days in a row** (Google's rule for personal
   accounts created after November 2023). Share the opt-in link with friends; they must keep it installed.
3. **Apply for production** from the Dashboard when the 14 days are up (Google asks a few questions about
   the test), then roll out.
4. **App Links:** after the first upload, copy the **App signing key** SHA-256 from
   Setup › App signing into `web/public/.well-known/assetlinks.json` (next to the upload key's) and
   redeploy the website, so invite links open the app.
