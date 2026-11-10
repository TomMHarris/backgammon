"use client";
// Small React hooks for the page layout and the engine.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { EngineClient, getEngine } from "@/engine/client";
import type { LoadProgress } from "@/engine/types";

/** true while the media query matches (false during server rendering). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * Size the board to fit its stage without scrolling.
 *
 * The stage is the flexible area between the header and the action bar. Its
 * child (the "table": player bars + board) is centred in it. We measure the
 * stage, subtract the height of everything in the table except the board,
 * and pick the largest board width whose height still fits, using the
 * board SVG's own aspect ratio (its viewBox). Returns the width in pixels
 * (null until measured) to apply as a CSS variable.
 */
export function useBoardFit(deps: unknown[] = []) {
  const stageRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);

  const measure = useCallback(() => {
    const stage = stageRef.current;
    const table = tableRef.current;
    if (!stage || !table) return;
    const svg = table.querySelector<SVGSVGElement>("svg.board");
    const vb = svg?.viewBox?.baseVal;
    const aspect = vb && vb.width && vb.height ? vb.width / vb.height : 786 / 504;
    const boardH = svg ? svg.getBoundingClientRect().height : 0;
    const chrome = table.getBoundingClientRect().height - boardH; // player bars + gaps
    const cs = getComputedStyle(stage);
    const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const availH = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - chrome;
    const w = Math.floor(Math.max(260, Math.min(availW, availH * aspect)));
    setWidth((old) => (old !== null && Math.abs(old - w) < 1 ? old : w));
  }, []);

  useLayoutEffect(() => {
    measure();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(stage);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);

  return { stageRef, tableRef, width };
}

/** The width of an element (0 until measured), following resizes. */
export function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w };
}

/** Start the engine (once per page) and report download progress, version and errors. */
export function useEngine() {
  const engineRef = useRef<EngineClient | null>(null);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  useEffect(() => {
    const engine = getEngine();
    engineRef.current = engine;
    engine.onProgress = setProgress;
    engine.ready.then(setVersion).catch((e: Error) => setInitError(`The engine could not start: ${e.message}`));
  }, []);
  return { engineRef, progress, version, initError, ready: version !== null };
}
