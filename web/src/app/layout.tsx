import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gnubg-web",
  description: "GNU Backgammon's engine in the browser: play and analyse.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f4f0" },
    { media: "(prefers-color-scheme: dark)", color: "#111214" },
  ],
};

// Apply a saved Light/Dark choice before the first paint (no flash). The key
// and values match lib/settings.ts; "auto" leaves the system preference in charge.
const THEME_BOOT = `try{var s=JSON.parse(localStorage.getItem("gnubg-web.options")||"{}");if(s.theme==="light"||s.theme==="dark")document.documentElement.dataset.theme=s.theme}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
