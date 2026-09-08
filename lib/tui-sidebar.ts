import { durationText } from "./quota-format.js";
import type { ProbeSnapshot } from "./codex-usage-probe.js";
import {
  aggregateAssistantTokenUsage,
  type TokenUsage,
  type UsageMessage,
  type UsagePart,
} from "./session-token-usage.js";

export type TuiSidebarApi = {
  readonly state?: {
    readonly session: {
      readonly get: (sessionId: string) => { tokens?: TokenUsage } | undefined;
      readonly messages?: (sessionId: string) => readonly UsageMessage[];
    };
    readonly part?: (messageId: string) => readonly UsagePart[];
  };
};

export type SidebarSolidRuntime = {
  readonly createElement: (kind: string) => unknown;
  readonly setProp: (element: unknown, name: string, value: unknown) => void;
  readonly insert: (parent: unknown, child: unknown) => void;
  readonly createComponent: (
    component: (props: { sessionId: string }) => unknown,
    props: { sessionId: string },
  ) => unknown;
};

export type PanelView = {
  readonly latest: ProbeSnapshot | undefined;
  readonly lastGood: ProbeSnapshot | undefined;
};

export type SidebarSignals = {
  readonly view: () => PanelView;
  readonly now: () => number;
  readonly usageRevision: () => number;
};

const formatNumber = (value: number | null | undefined): string => {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "-";
};

const sessionTokenUsage = (api: TuiSidebarApi, sessionId: string): TokenUsage | undefined => {
  const session = api.state?.session;
  if (!session) return undefined;
  const messages = session.messages?.(sessionId) ?? [];
  return aggregateAssistantTokenUsage(
    messages,
    (messageId) => api.state?.part?.(messageId) ?? [],
    session.get(sessionId)?.tokens,
  );
};

const remainingText = (value: number | null | undefined): string => {
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

const livePanelText = (solid: SidebarSolidRuntime, text: () => string): unknown => {
  const node = solid.createElement("text");
  solid.insert(node, text);
  return node;
};

const currentView = (view: PanelView): ProbeSnapshot | undefined => {
  if (view.latest && !view.latest.error) return view.latest;
  return view.lastGood;
};

const isStaleView = (view: PanelView): boolean => {
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

const quotaLineText = (
  label: string,
  used: number | null | undefined,
  resetAtMs: number | null | undefined,
  resetFallback: string | null | undefined,
  nowMs: number,
): string => {
  return `${label}: ${remainingText(used)} · ${countdownText(resetAtMs, resetFallback, nowMs)}`;
};

const primaryLineText = (view: PanelView, nowMs: number): string => {
  const snapshot = currentView(view);
  if (!snapshot) return view.latest?.error ? "Quota: error" : "Quota: loading…";
  if (snapshot.error) return "Quota: error";
  const used = usedPair(snapshot);
  const reset = resetPair(snapshot);
  const resetAtMs = resetAtPair(snapshot);
  if (used.primary === undefined && reset.primary === undefined) return "Quota: error";
  return quotaLineText("5h", used.primary, resetAtMs.primary, reset.primary, nowMs);
};

const secondaryLineText = (view: PanelView, nowMs: number): string => {
  const snapshot = currentView(view);
  if (!snapshot || snapshot.error) return "";
  const used = usedPair(snapshot);
  const reset = resetPair(snapshot);
  const resetAtMs = resetAtPair(snapshot);
  if (used.secondary === undefined && reset.secondary === undefined) return "";
  return quotaLineText("7d", used.secondary, resetAtMs.secondary, reset.secondary, nowMs);
};

export const buildSidebarComponent = (
  solid: SidebarSolidRuntime,
  api: TuiSidebarApi,
  signals: SidebarSignals,
): ((props: { sessionId: string }) => unknown) => {
  return (props: { sessionId: string }): unknown => {
    const box = solid.createElement("box");
    solid.setProp(box, "flexDirection", "column");
    solid.setProp(box, "paddingLeft", 1);
    solid.setProp(box, "paddingRight", 1);

    const title = solid.createElement("text");
    solid.setProp(title, "fg", "cyan");
    solid.insert(title, "Codex quota");
    solid.insert(box, title);

    solid.insert(
      box,
      livePanelText(solid, () => primaryLineText(signals.view(), signals.now())),
    );
    solid.insert(
      box,
      livePanelText(solid, () => secondaryLineText(signals.view(), signals.now())),
    );
    solid.insert(
      box,
      livePanelText(solid, () => (isStaleView(signals.view()) ? "stale · last known" : "")),
    );

    const usage = (): TokenUsage | undefined => {
      signals.usageRevision();
      return sessionTokenUsage(api, props.sessionId);
    };

    solid.insert(
      box,
      livePanelText(solid, () => `input: ${formatNumber(usage()?.input)}`),
    );
    solid.insert(
      box,
      livePanelText(solid, () => `output: ${formatNumber(usage()?.output)}`),
    );
    solid.insert(
      box,
      livePanelText(
        solid,
        () =>
          `cache: ${formatNumber(usage()?.cache.read)} read · ${formatNumber(usage()?.cache.write)} write`,
      ),
    );

    return box;
  };
};
