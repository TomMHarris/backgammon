// /analysis: gnubg's analysis of a whole match, decision by decision.
// Everything runs in the browser (see components/analysis/AnalysisPage.tsx).
import type { Metadata } from "next";
import AnalysisPage from "@/components/analysis/AnalysisPage";

export const metadata: Metadata = {
  title: "Analysis · gnubg-web",
  description: "GNU Backgammon analyses a match in your browser: every move and cube decision, luck, and gnubg's statistics.",
};

export default function Analysis() {
  return <AnalysisPage />;
}
