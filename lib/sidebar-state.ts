import type { ProbeSnapshot } from "./codex-usage-probe.js";
import {
  aggregateAssistantTokenUsage,
  type TokenUsage,
  type UsageMessage,
} from "./session-token-usage.js";
import type { PanelView } from "./sidebar-text.js";

/**
 * Folds a probe result into the panel view. A failed probe keeps the previous
 * good snapshot so the sidebar can show quota alongside a staleness marker
 * instead of blanking out.
 */
export const nextPanelView = (previous: PanelView, snapshot: ProbeSnapshot): PanelView => {
  return {
    latest: snapshot,
    lastGood: snapshot.error ? previous.lastGood : snapshot,
  };
};

/**
 * Codex quota belongs to the ChatGPT account behind OpenAI models. An unknown
 * provider is treated as eligible so a not-yet-resolved session is not silently
 * blanked; a known non-OpenAI provider hides the quota block.
 */
export const isQuotaProvider = (providerID: string | undefined): boolean => {
  return providerID === undefined || providerID === "openai";
};

/**
 * Narrows host session messages down to assistant token totals.
 *
 * OpenCode 2 exposes session totals directly and per-assistant-message totals,
 * but no message-part accessor, so the step-finish fallback used by the V1 TUI
 * is not reachable here.
 */
export const usageFromMessages = (
  messages: readonly UsageMessage[],
  fallback?: TokenUsage,
): TokenUsage | undefined => {
  return aggregateAssistantTokenUsage(messages, undefined, fallback);
};
