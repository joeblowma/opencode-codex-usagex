import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSignal } from "solid-js";
import { probeQuota } from "./lib/codex-usage-probe.js";
import {
  resolvePollMs,
  resolveToastDurationMs,
  toastBodyFromParsed,
} from "./lib/codex-usage-toast-plugin.js";
import {
  buildSidebarComponent,
  type PanelView,
  type SidebarSolidRuntime,
  type TuiSidebarApi,
} from "./lib/tui-sidebar.js";

type TuiToast = {
  title?: string;
  message: string;
  variant?: "info" | "success" | "warning" | "error";
  duration?: number;
};

type SidebarSlotProps = {
  readonly session_id: string;
};

type TuiApi = {
  command: {
    register: (
      callback: () => Array<{
        title: string;
        value: string;
        description: string;
        category: string;
        slash: { name: string };
        onSelect: () => void;
      }>,
    ) => () => void;
  };
  ui: {
    toast: (input: TuiToast) => void;
  };
  lifecycle: {
    onDispose: (dispose: () => void) => () => void;
  };
  slots?: {
    register: (registration: {
      order?: number;
      slots: { sidebar_content: (context: unknown, props: SidebarSlotProps) => unknown };
    }) => string;
  };
  state?: TuiSidebarApi["state"];
  renderer?: { requestRender: () => void };
  event?: {
    on: (
      type: "message.updated" | "message.removed" | "message.part.updated",
      handler: (event: { properties: { sessionID: string } }) => void,
    ) => () => void;
  };
};

const COUNTDOWN_TICK_MS = 30_000;
const TUI_DEBUG_ENV = "OPENCODE_CODEX_USAGE_TUI_DEBUG";
const debugLogPath = path.join(os.tmpdir(), "opencode-codex-usage-tui-debug.log");

const debugEnabled = (): boolean => {
  const value = process.env[TUI_DEBUG_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
};

const debugLog = (message: string, extra: Record<string, unknown> = {}): void => {
  if (!debugEnabled()) return;
  const line = JSON.stringify({ time: new Date().toISOString(), message, ...extra });
  void appendFile(debugLogPath, `${line}\n`, "utf8").catch(() => undefined);
};

export const CodexQuotaTuiPlugin = async (
  api: TuiApi,
  injected?: { solid?: SidebarSolidRuntime },
): Promise<void> => {
  const toastDurationMs = resolveToastDurationMs();
  const pollMs = resolvePollMs();
  let running = false;
  // Reactive panel state. The host renders sidebar_content once as a Solid
  // tree; quota lines subscribe to these signals, so polls and countdown
  // ticks update the visible text without re-invoking the slot function.
  const [panelView, setPanelView] = createSignal<PanelView>({
    latest: undefined,
    lastGood: undefined,
  });
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [usageRevision, setUsageRevision] = createSignal(0);
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  const eventDisposers: Array<() => void> = [];
  // NOTE: api.slots.register() returns a host-assigned slot id (string), not an
  // unregister function. Slot registrations are tracked and disposed by the TUI
  // runtime automatically, so there is nothing to call here on cleanup.
  let slotId: string | undefined;

  const refreshSidebar = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const snapshot = await probeQuota();
      const previous = panelView();
      setPanelView({
        latest: snapshot,
        lastGood: snapshot.error ? previous.lastGood : snapshot,
      });
      debugLog("sidebar refreshed", {
        hasError: snapshot.error ?? "",
        status: snapshot.status,
      });
      api.renderer?.requestRender();
    } finally {
      running = false;
    }
  };

  // `injected.solid` is a test seam: @opentui/solid needs Bun FFI and cannot load
  // under plain node --test, so tests inject a fake runtime instead.
  const solid =
    injected?.solid ??
    ((await import("@opentui/solid").catch(() => undefined)) as SidebarSolidRuntime | undefined);
  if (solid && api.slots) {
    const QuotaPanel = buildSidebarComponent(solid, api, {
      view: panelView,
      now: nowMs,
      usageRevision,
    });
    slotId = api.slots.register({
      order: 900,
      slots: {
        sidebar_content: (_context, props) => {
          const sessionId = props.session_id;
          return solid.createComponent(QuotaPanel, { sessionId });
        },
      },
    });
    pollTimer = setInterval(() => void refreshSidebar(), pollMs);
    countdownTimer = setInterval(() => setNowMs(Date.now()), COUNTDOWN_TICK_MS);
    void refreshSidebar();
  }

  if (api.event) {
    const refreshTokenUsage = (): void => {
      setUsageRevision((revision) => revision + 1);
      api.renderer?.requestRender();
    };
    eventDisposers.push(api.event.on("message.updated", refreshTokenUsage));
    eventDisposers.push(api.event.on("message.removed", refreshTokenUsage));
    eventDisposers.push(api.event.on("message.part.updated", refreshTokenUsage));
  }

  debugLog("tui plugin loaded", {
    hasCommandRegister: typeof api.command?.register,
    hasToast: typeof api.ui?.toast,
  });

  if (debugEnabled()) {
    api.ui.toast({
      title: "Codex usage debug",
      message: `/codex-usage TUI plugin loaded; log: ${debugLogPath}`,
      variant: "info",
      duration: 10_000,
    });
  }

  const showToast = (toast: TuiToast): void => {
    debugLog("toast shown", {
      title: toast.title ?? "",
      variant: toast.variant ?? "",
      duration: toast.duration ?? 0,
      messageLength: toast.message.length,
    });
    api.ui.toast(toast);
  };

  const runProbe = async (): Promise<void> => {
    debugLog("run probe requested", { running });
    if (running) return;
    running = true;

    try {
      const parsed = await probeQuota();
      const probeError = parsed.error?.trim();
      if (probeError) {
        showToast({
          title: "Codex quota 🚨",
          message: `🚨 Quota error | ${probeError}`,
          variant: "error",
          duration: toastDurationMs,
        });
        return;
      }

      showToast(toastBodyFromParsed(parsed, toastDurationMs));
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      showToast({
        title: "Codex quota 🚨",
        message: `🚨 Quota error | ${detail}`,
        variant: "error",
        duration: toastDurationMs,
      });
    } finally {
      running = false;
    }
  };

  const dispose = api.command.register(() => [
    ...(() => {
      const command = {
        title: "Codex usage",
        value: "codex-usage",
        description: "Show Codex quota",
        category: "Codex",
        slash: { name: "codex-usage" },
        onSelect: () => {
          debugLog("command selected");
          void runProbe();
        },
      };
      debugLog("register callback returned command", {
        value: command.value,
        slashName: command.slash.name,
      });
      return [command];
    })(),
  ]);
  debugLog("command registered");

  api.lifecycle.onDispose(() => {
    debugLog("tui plugin disposed", { slotId });
    if (pollTimer) clearInterval(pollTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    for (const disposeEvent of eventDisposers) disposeEvent();
    dispose();
  });
};

export default { id: "opencode-codex-usage", tui: CodexQuotaTuiPlugin };
