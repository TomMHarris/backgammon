import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, DM_Mono, Inter } from "next/font/google";
import "./globals.css";

// Fonts are downloaded at build time and served with the app (no requests to
// Google at runtime). They are exposed as CSS variables used by globals.css
// and by the board:
//   --font-sans   Inter: all UI text (a neutral, very legible sans at small sizes)
//   --font-mono   DM Mono: numbers that line up (equities, pips, scores, %, point numbers)
//   --font-serif  Cormorant Garamond: dialog titles only
const sans = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });
const serif = Cormorant_Garamond({ subsets: ["latin"], weight: ["500"], variable: "--font-serif", display: "swap" });

export const metadata: Metadata = {
  title: "gnubg-web",
  description: "GNU Backgammon's engine in the browser: play and analyse.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf8f4" },
    { media: "(prefers-color-scheme: dark)", color: "#2e2b26" },
  ],
};

// Apply a saved Light/Dark choice before the first paint (no flash). The key
// and values match lib/settings.ts; "auto" leaves the system preference in charge.
const THEME_BOOT = `try{var s=JSON.parse(localStorage.getItem("gnubg-web.options")||"{}");if(s.theme==="light"||s.theme==="dark")document.documentElement.dataset.theme=s.theme}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${serif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
