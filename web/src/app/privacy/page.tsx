// /privacy: the privacy policy of the website and the Android app (linked
// from the Google Play listing, which requires one). A static page.
import type { Metadata } from "next";
import Link from "next/link";
import styles from "../about/about.module.css";

export const metadata: Metadata = {
  title: "Privacy · gnubg-web",
  description: "Privacy policy of gnubg-web and the Backgammon Android app.",
};

const REPO = "https://github.com/TomMHarris/backgammon";
const UPDATED = "15 November 2026";

export default function Privacy() {
  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link href="/" className={styles.brand}>
          gnubg-web
        </Link>
        <Link href="/" className="flat flat-sm flat-primary">
          Play
        </Link>
      </header>

      <main className={styles.col}>
        <h1 className={styles.title}>Privacy</h1>
        <p className={styles.lede}>
          This policy covers the website and the Backgammon app for Android (package io.github.tommharris.backgammon), which is the same
          program. In short: there are no accounts, no ads, no analytics and no tracking. Last updated {UPDATED}.
        </p>

        <section className={styles.section}>
          <h2>Playing against gnubg and analysis</h2>
          <p>
            Games against GNU Backgammon, hints and match analysis run entirely on your device. Nothing about these games is sent anywhere.
            Your settings and your games in progress are kept on your device only (in the browser&apos;s or the app&apos;s local storage),
            and are deleted if you clear the site&apos;s data or uninstall the app. Match files you open or save stay on your device unless
            you choose to share them.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Online games with a friend</h2>
          <p>
            When you create or join an online game, the game server stores, for that game only: the name you type for yourself, the match
            settings, the moves and dice rolls, and a random token that identifies your seat. This is needed to play the game; it is not
            linked to any account or device identifier. Each game is deleted automatically one week after its last move. The server runs on
            Vercel with an Upstash Redis database; like any web host, they process your IP address to deliver the requests, under their own
            privacy policies. Anyone with the game&apos;s link can see the players&apos; names and the moves.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Tips (Android app)</h2>
          <p>
            Tips in the app are optional in-app purchases handled entirely by Google Play. Payment details go to Google, never to us. Google
            shares the usual order information with the developer (such as the order number, the product, the price and the country), which
            is used only for accounting, taxes and refunds.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Children</h2>
          <p>The app is not directed at children and collects no personal information beyond what is described above.</p>
        </section>

        <section className={styles.section}>
          <h2>Contact and changes</h2>
          <p>
            Questions or requests (for example to delete an online game before it expires): open an issue at{" "}
            <a href={`${REPO}/issues`}>{REPO.replace("https://", "")}/issues</a>. Changes to this policy are published on this page, and the
            source code of everything described here is <a href={REPO}>public</a>.
          </p>
        </section>
      </main>
    </div>
  );
}
