import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createMemo, createSignal } from "solid-js";
import type { SessionMessageInfo } from "@opencode/client";
import {
  resolvePollMs,
  resolveToastDurationMs,
  toastBodyFromParsed,
} from "./lib/codex-usage-toast-plugin.js";
import { CODEX_USAGE_RPC, ProbeSnapshotSchema } from "./lib/opencode2-rpc.js";
import type { ProbeSnapshot } from "./lib/codex-usage-probe.js";
import { SidebarPanel, type SidebarColors } from "./lib/sidebar-panel.js";
import { isQuotaProvider, nextPanelView, usageFromMessages } from "./lib/sidebar-state.js";
import type { PanelView } from "./lib/sidebar-text.js";
import type { UsageMessage } from "./lib/session-token-usage.js";

const COUNTDOWN_TICK_MS = 30_000;

const usageMessages = (messages: readonly SessionMessageInfo[]): UsageMessage[] => {
  return messages.flatMap((message) => {
    if (message.type !== "assistant") return [];
    return [{ id: message.id, role: "assistant", tokens: message.tokens }];
  });
};

export const CodexQuotaTuiPlugin = Plugin.define({
  id: "opencode-codex-usage",
  setup(ctx) {
    const pollMs = resolvePollMs();
    const toastDurationMs = resolveToastDurationMs();

    const [panelView, setPanelView] = createSignal<PanelView>({
      latest: undefined,
      lastGood: undefined,
    });
    const [nowMs, setNowMs] = createSignal(Date.now());
    const [usageRevision, setUsageRevision] = createSignal(0);
    const [quotaVisible, setQuotaVisible] = createSignal(false);

    let running = false;

    /**
     * Records a failure as panel state. The RPC can reject (transport) or hand
     * back an error snapshot; either way the panel must leave "loading…", so
     * the sidebar reports the failure instead of appearing stuck.
     */
    const recordFailure = (detail: string): ProbeSnapshot => {
      const snapshot: ProbeSnapshot = { status: "error", statusCode: "rpc", error: detail };

      setPanelView((previous) => nextPanelView(previous, snapshot));

      return snapshot;
    };

    const readQuota = async (): Promise<ProbeSnapshot> => {
      try {
        const snapshot = ProbeSnapshotSchema.parse(await ctx.client.rpc(CODEX_USAGE_RPC).usage({}));

        setPanelView((previous) => nextPanelView(previous, snapshot));

        return snapshot;
      } catch (error: unknown) {
        return recordFailure(error instanceof Error ? error.message : String(error));
      }
    };

    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        await readQuota();
      } finally {
        running = false;
      }
    };

    const showQuotaToast = async () => {
      const snapshot = await readQuota();

      ctx.ui.toast.show(toastBodyFromParsed(snapshot, toastDurationMs));
    };

    // Reading the route reactively catches model switches as well as navigation.
    const selection = createMemo(() => {
      const route = ctx.ui.router.current();

      if (route.type !== "session") return undefined;

      const session = ctx.data.session.get(route.sessionID);

      return { sessionID: route.sessionID, providerID: session?.model?.providerID };
    });

    // Quota belongs to the ChatGPT account behind OpenAI models only. Token
    // usage is per session and stays visible regardless of provider.
    createEffect(() => {
      const current = selection();

      if (!current) {
        setQuotaVisible(false);

        return;
      }

      setQuotaVisible(isQuotaProvider(current.providerID));
    });

    // Colors come from the resolved host theme so the block follows light/dark
    // and any custom palette instead of baking in a fixed foreground. An absent
    // theme resolves to undefined, leaving `fg` unset so the host foreground wins.
    const colors = (): SidebarColors | undefined => {
      const text = ctx.theme?.text;

      if (!text?.base) return undefined;

      return { base: text.base, muted: text.muted ?? text.base };
    };

    const releaseSlot = ctx.ui.slot({
      append: "sidebar.content",
      render: (input) => {
        const usage = () => {
          usageRevision();

          return usageFromMessages(
            usageMessages(ctx.data.session.message.list(input.sessionID)),
            ctx.data.session.get(input.sessionID)?.tokens,
          );
        };

        // Called as a function rather than via JSX so this module stays free of
        // a static @opentui/solid import; the panel itself owns the JSX.
        return SidebarPanel({ view: panelView, now: nowMs, usage, colors, quotaVisible });
      },
    });

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "codex_usage",
          title: "Codex usage",
          description: "Show current Codex quota",
          group: "Codex",
          bind: "ctrl+x u",
          palette: true,
          slash: { name: "codex-usage" },
          run: () => void showQuotaToast(),
        },
      ],
    }));

    // Token totals move with message content updates; anything narrower than
    // this prefix would miss streamed usage the sidebar is meant to reflect.
    const stopListening = ctx.data.listen(({ details }) => {
      if (!details.type.startsWith("session.message")) return;

      setUsageRevision((revision) => revision + 1);
    });

    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const stopPolling = () => {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = undefined;
    };

    createEffect(() => {
      if (!quotaVisible()) {
        stopPolling();

        return;
      }

      stopPolling();
      pollTimer = setInterval(() => void refresh(), pollMs);
      void refresh();
    });

    const countdownTimer = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);

    return () => {
      stopPolling();
      clearInterval(countdownTimer);
      stopListening();
      releaseSlot();
    };
  },
});

export default CodexQuotaTuiPlugin;
