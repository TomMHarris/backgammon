import type { MetadataRoute } from "next";

// The web app manifest (served as /manifest.webmanifest). It is what Chrome
// reads when the site is installed or added to the home screen: the name under
// the icon, the icons themselves, and the colours of the splash screen.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "gnubg-web — Backgammon",
    short_name: "Backgammon",
    description: "GNU Backgammon's engine in the browser: play and analyse.",
    start_url: "/",
    display: "standalone",
    background_color: "#faf8f4",
    theme_color: "#faf8f4",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Full-bleed version: Android crops it to its own shape (circle, squircle...).
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
