import { Show } from "solid-js";
import type { RGBA } from "@opentui/core";
import type { TokenUsage } from "./session-token-usage.js";
import {
  formatNumber,
  primaryLineText,
  secondaryLineText,
  staleLineText,
  type PanelView,
} from "./sidebar-text.js";

/**
 * Host theme colors, taken from `ctx.theme`. Hardcoding a color here would
 * ignore the user's light/dark theme, so every line resolves through this.
 */
export type SidebarColors = {
  /** Default foreground for primary content. */
  readonly base: RGBA;
  /** De-emphasised foreground for secondary content. */
  readonly muted: RGBA;
};

export type SidebarPanelProps = {
  /** Latest probe result plus the last non-error result, for stale display. */
  readonly view: () => PanelView;
  /** Current clock, read reactively so countdown lines tick. */
  readonly now: () => number;
  /** Session token totals, read reactively so usage lines update. */
  readonly usage: () => TokenUsage | undefined;
  /** Resolved host colors, or undefined to inherit the host's default foreground. */
  readonly colors: () => SidebarColors | undefined;
  /**
   * Whether this session's model is served by OpenAI. Quota lines are hidden
   * for other providers; token usage is always meaningful and stays visible.
   */
  readonly quotaVisible: () => boolean;
};

/**
 * Renders the Codex quota block into the host's `sidebar.content` slot.
 *
 * Every line is a reactive child, so polls and countdown ticks update the
 * visible text without re-invoking the slot's render function.
 */
export const SidebarPanel = (props: SidebarPanelProps) => {
  // SAFETY: `ctx.theme` types resolve to `any` because `@opencode/theme` is not
  // a direct dependency, so the runtime shape is unverified at compile time. An
  // absent theme yields undefined colors, which leaves `fg` unset and inherits
  // the host foreground instead of throwing.
  const base = () => props.colors()?.base;
  const muted = () => props.colors()?.muted;

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Show when={props.quotaVisible()}>
        <text fg={base()}>Codex quota</text>
        <text fg={base()}>{primaryLineText(props.view(), props.now())}</text>
        <text fg={muted()}>{secondaryLineText(props.view(), props.now())}</text>
        <text fg={muted()}>{staleLineText(props.view())}</text>
      </Show>
      <text fg={base()}>{`input: ${formatNumber(props.usage()?.input)}`}</text>
      <text fg={base()}>{`output: ${formatNumber(props.usage()?.output)}`}</text>
      <text
        fg={muted()}
      >{`cache: ${formatNumber(props.usage()?.cache.read)} read · ${formatNumber(props.usage()?.cache.write)} write`}</text>
    </box>
  );
};

export default SidebarPanel;
