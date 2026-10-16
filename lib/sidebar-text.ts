import { durationText } from "./quota-format.js";
import type { ProbeSnapshot } from "./codex-usage-probe.js";

export type PanelView = {
  readonly latest: ProbeSnapshot | undefined;
  readonly lastGood: ProbeSnapshot | undefined;
};

export const formatNumber = (value: number | null | undefined): string => {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "-";
};

export const remainingText = (value: number | null | undefined): string => {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.max(0, Math.min(100, 100 - value))}% left`
    : "-";
};

const countdownText = (
  resetAtMs: number | null | undefined,
  fallback: string | null | undefined,
  nowMs: number,
): string => {
  if (typeof resetAtMs === "number" && Number.isFinite(resetAtMs)) {
    return durationText(String(Math.max(0, Math.round((resetAtMs - nowMs) / 1000))));
  }
  return fallback && fallback.trim() !== "" ? fallback : "-";
};

export const currentView = (view: PanelView): ProbeSnapshot | undefined => {
  if (view.latest && !view.latest.error) return view.latest;
  return view.lastGood;
};

export const isStaleView = (view: PanelView): boolean => {
  return (
    view.latest?.error !== undefined &&
    view.latest.error !== "" &&
    currentView(view) === view.lastGood
  );
};

type UsedPair = { primary?: number | null; secondary?: number | null };
type ResetPair = { primary?: string | null; secondary?: string | null };
type ResetAtPair = { primary?: number | null; secondary?: number | null };

const usedPair = (snapshot: ProbeSnapshot | undefined): UsedPair => {
  if (!snapshot?.used || typeof snapshot.used !== "object") return {};
  return snapshot.used;
};

const resetPair = (snapshot: ProbeSnapshot | undefined): ResetPair => {
  if (!snapshot?.reset || typeof snapshot.reset !== "object") return {};
  return snapshot.reset;
};

const resetAtPair = (snapshot: ProbeSnapshot | undefined): ResetAtPair => {
  if (!snapshot?.resetAtMs || typeof snapshot.resetAtMs !== "object") return {};
  return snapshot.resetAtMs;
};

/**
 * A window lane that is absent is reported as `null`, not `undefined`. Treating
 * null as present would render placeholder lines such as `7d: - · -` for
 * accounts that only expose a 5h window.
 */
const hasValue = (value: number | string | null | undefined): boolean => {
  return value !== undefined && value !== null;
};

const quotaLineText = (
  label: string,
  used: number | null | undefined,
  resetAtMs: number | null | undefined,
  resetFallback: string | null | undefined,
  nowMs: number,
): string => {
  return `${label}: ${remainingText(used)} · ${countdownText(resetAtMs, resetFallback, nowMs)}`;
};

export const primaryLineText = (view: PanelView, nowMs: number): string => {
  const snapshot = currentView(view);
  if (!snapshot) return view.latest?.error ? "Quota: error" : "Quota: loading…";
  if (snapshot.error) return "Quota: error";
  const used = usedPair(snapshot);
  const reset = resetPair(snapshot);
  const resetAtMs = resetAtPair(snapshot);
  if (!hasValue(used.primary) && !hasValue(reset.primary)) return "Quota: error";
  return quotaLineText("5h", used.primary, resetAtMs.primary, reset.primary, nowMs);
};

export const secondaryLineText = (view: PanelView, nowMs: number): string => {
  const snapshot = currentView(view);
  if (!snapshot || snapshot.error) return "";
  const used = usedPair(snapshot);
  const reset = resetPair(snapshot);
  const resetAtMs = resetAtPair(snapshot);
  if (!hasValue(used.secondary) && !hasValue(reset.secondary)) return "";
  return quotaLineText("7d", used.secondary, resetAtMs.secondary, reset.secondary, nowMs);
};

export const staleLineText = (view: PanelView): string => {
  return isStaleView(view) ? "stale · last known" : "";
};
