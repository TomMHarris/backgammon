// /about: what this site is, credits, the GPL notice and where to get the
// corresponding source code. A static page (no engine); the versions shown are
// read at build time from engine/versions.env, so they always match the
// WebAssembly engine that this build ships.
import type { Metadata } from "next";
import Link from "next/link";
import { readFileSync } from "node:fs";
import path from "node:path";
import styles from "./about.module.css";

export const metadata: Metadata = {
  title: "About · gnubg-web",
  description: "About gnubg-web: credits, licence (GPL v3) and source code.",
};

const REPO = "https://github.com/TomMHarris/backgammon";

/** KEY=value pairs from engine/versions.env (next build runs in web/). */
function pinnedVersions(): Record<string, string> {
  const text = readFileSync(path.join(process.cwd(), "../engine/versions.env"), "utf8");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export default function About() {
  const v = pinnedVersions();
  // Vercel sets this during its builds; links the exact source of this deployment.
  const commit = process.env.VERCEL_GIT_COMMIT_SHA;
  const tree = `${REPO}/tree/${commit ?? "main"}`;

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link href="/" className={styles.brand}>
          gnubg-web
        </Link>
        <Link href="/" className="flat flat-sm flat-primary" data-testid="about-play">
          Play
        </Link>
      </header>

      <main className={styles.col}>
        <h1 className={styles.title}>About</h1>
        <p className={styles.lede}>
          gnubg-web lets you play backgammon against GNU Backgammon (gnubg), one of the strongest backgammon programs, in your web browser.
          It is gnubg {v.GNUBG_VERSION} itself, compiled from the official source code to WebAssembly: the moves, hints, cube decisions and
          match analysis are computed by the same code as the desktop program, entirely on your device. Nothing you play is sent to a server.
        </p>

        <section className={styles.section}>
          <h2>Credits</h2>
          <ul className={styles.list}>
            <li>
              <a href="https://www.gnu.org/software/gnubg/">GNU Backgammon</a>, written by Joseph Heled, Oystein Johansen, Joern Thyssen, Gary
              Wong, David Montgomery, Christian Anthon, Jim Segrave, Jonathan Kinsey, Michael Petch and Philippe Michel, with many other
              contributors. Its neural networks, bearoff databases and match
              equity tables are used unchanged. Licence: GPL v3 or later.
            </li>
            <li>
              <a href="https://github.com/hwatheod/gnubg-web">gnubg-web by Theodore Hwa</a>, the first port of gnubg to the browser, which
              showed how to build it with Emscripten. This project follows its method with a newer gnubg.
            </li>
            <li>
              <a href="https://docs.gtk.org/glib/">GLib</a> {v.GLIB_VERSION} (LGPL 2.1 or later), with{" "}
              <a href="https://github.com/PCRE2Project/pcre2">PCRE2</a> {v.PCRE2_VERSION} (BSD licence): the utility library gnubg is built on.
            </li>
            <li>
              <a href="https://emscripten.org/">Emscripten</a> {v.EMSDK_VERSION} (MIT / University of Illinois licence), which compiles the C
              code to WebAssembly, including its C library (musl, MIT licence).
            </li>
            <li>
              <a href="https://github.com/DaveGamble/cJSON">cJSON</a> {v.CJSON_VERSION} (MIT licence), for the engine&apos;s JSON interface.
            </li>
            <li>
              <a href="https://nextjs.org/">Next.js</a> and <a href="https://react.dev/">React</a> (MIT licence) for the web app; fonts Inter,
              DM Mono and Cormorant Garamond (SIL Open Font Licence).
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2>The dice</h2>
          <p>
            Every roll, yours and gnubg&apos;s, comes from your browser&apos;s cryptographic random number generator (
            <code>crypto.getRandomValues</code>), with no bias towards any number (
            <a href={`${REPO}/blob/main/web/src/game/dice.ts`}>the code</a>). gnubg never sees a roll before it is made and cannot choose
            its dice. The luck figures in the game summary are gnubg&apos;s own measure of how much each side&apos;s rolls helped; in a short
            match they can be very lopsided by chance alone.
          </p>
        </section>

        <section className={styles.section}>
          <h2>Licence</h2>
          <p>
            gnubg-web is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as
            published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
          </p>
          <p>
            This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
            MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
          </p>
          <p>
            <a href="/LICENSE.txt">Full text of the GNU General Public License, version 3</a>
          </p>
        </section>

        <section className={styles.section}>
          <h2>Source code</h2>
          <p>
            The complete source of this site, including the scripts that build the WebAssembly engine, is at{" "}
            <a href={REPO}>github.com/TomMHarris/backgammon</a>
            {commit && (
              <>
                {" "}
                (this build: <a href={tree}>{commit.slice(0, 7)}</a>)
              </>
            )}
            . The engine is built from these official upstream releases, to which the build applies a small set of patches:
          </p>
          <dl className={styles.sources}>
            <div>
              <dt>GNU Backgammon {v.GNUBG_VERSION}</dt>
              <dd>
                <a href={v.GNUBG_URL}>{v.GNUBG_URL?.split("/").pop()}</a>
                <span className={styles.hash}>sha-256 {v.GNUBG_SHA256}</span>
              </dd>
            </div>
            <div>
              <dt>GLib {v.GLIB_VERSION}</dt>
              <dd>
                <a href={v.GLIB_URL}>{v.GLIB_URL?.split("/").pop()}</a>
              </dd>
            </div>
            <div>
              <dt>PCRE2 {v.PCRE2_VERSION}</dt>
              <dd>
                <a href={v.PCRE2_URL}>{v.PCRE2_FILE}</a>
              </dd>
            </div>
            <div>
              <dt>cJSON {v.CJSON_VERSION}</dt>
              <dd>
                <a href={v.CJSON_URL}>v{v.CJSON_VERSION}.tar.gz</a>
              </dd>
            </div>
            <div>
              <dt>Our changes</dt>
              <dd>
                <a href={`${tree}/engine/patches`}>engine/patches</a> (patches to gnubg and GLib),{" "}
                <a href={`${tree}/engine/api`}>engine/api</a> (the engine interface) and{" "}
                <a href={`${tree}/engine/build.sh`}>engine/build.sh</a> (the build, with every version and checksum in{" "}
                <a href={`${tree}/engine/versions.env`}>engine/versions.env</a>)
              </dd>
            </div>
          </dl>
        </section>

        <footer className={styles.foot}>
          <Link href="/" className="flat flat-primary">
            Play
          </Link>
        </footer>
      </main>
    </div>
  );
}
