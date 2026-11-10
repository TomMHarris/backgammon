import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gnubg-web",
  description: "GNU Backgammon's engine in the browser: play and analyse.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
