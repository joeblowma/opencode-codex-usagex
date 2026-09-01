import { appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { probeQuota } from "./lib/codex-usage-probe.js";
import { resolveToastDurationMs, toastBodyFromParsed } from "./lib/codex-usage-toast-plugin.js";

type TuiToast = {
  title?: string;
  message: string;
  variant?: "info" | "success" | "warning" | "error";
  duration?: number;
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
      slots: { sidebar_content: (props: { session_id: string }) => unknown };
    }) => () => void;
  };
  state?: {
    session: {
      get: (sessionId: string) =>
        | {
            tokens?: {
              input?: number;
              output?: number;
              reasoning?: number;
              cache?: { read?: number; write?: number };
            };
          }
        | undefined;
    };
  };
  renderer?: { requestRender: () => void };
};

type SolidRuntime = {
  createElement: (kind: string) => unknown;
  setProp: (element: unknown, name: string, value: unknown) => void;
  insert: (parent: unknown, child: unknown) => void;
};

type QuotaSnapshot = Awaited<ReturnType<typeof probeQuota>>;

const formatNumber = (value: number | null | undefined): string => {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "-";
};

const remainingText = (value: number | null | undefined): string => {
  return typeof value === "number" && Number.isFinite(value)
    ? `${Math.max(0, Math.min(100, 100 - value))}% left`
    : "-";
};

const panelText = (solid: SolidRuntime, text: string): unknown => {
  const node = solid.createElement("text");
  solid.insert(node, text);
  return node;
};

const buildSidebarPanel = (
  solid: SolidRuntime,
  api: TuiApi,
  snapshot: QuotaSnapshot | undefined,
  sessionId: string,
): unknown => {
  const box = solid.createElement("box");
  solid.setProp(box, "flexDirection", "column");
  solid.setProp(box, "paddingLeft", 1);
  solid.setProp(box, "paddingRight", 1);

  const title = solid.createElement("text");
  solid.setProp(title, "fg", "cyan");
  solid.insert(title, "Codex quota");
  solid.insert(box, title);

  const used = snapshot?.used;
  const reset = snapshot?.reset;
  if (used && typeof used === "object" && reset && typeof reset === "object") {
    solid.insert(
      box,
      panelText(solid, `5h: ${remainingText(used.primary)} · ${reset.primary ?? "-"}`),
    );
    solid.insert(
      box,
      panelText(solid, `7d: ${remainingText(used.secondary)} · ${reset.secondary ?? "-"}`),
    );
  } else {
    solid.insert(box, panelText(solid, snapshot?.error ? "Quota: error" : "Quota: loading…"));
  }

  const tokens = api.state?.session.get(sessionId)?.tokens;
  if (tokens) {
    solid.insert(box, panelText(solid, `input: ${formatNumber(tokens.input)}`));
    solid.insert(box, panelText(solid, `output: ${formatNumber(tokens.output)}`));
    solid.insert(box, panelText(solid, `cache: ${formatNumber(tokens.cache?.read)}`));
  }

  return box;
};

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

export const CodexQuotaTuiPlugin = async (api: TuiApi): Promise<void> => {
  const toastDurationMs = resolveToastDurationMs();
  let running = false;
  let latestSnapshot: QuotaSnapshot | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let unregisterSidebar: (() => void) | undefined;

  const refreshSidebar = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      latestSnapshot = await probeQuota();
      api.renderer?.requestRender();
    } finally {
      running = false;
    }
  };

  const solid = (await import("@opentui/solid").catch(() => undefined)) as SolidRuntime | undefined;
  if (solid && api.slots) {
    unregisterSidebar = api.slots.register({
      order: 900,
      slots: {
        sidebar_content: ({ session_id }) =>
          buildSidebarPanel(solid, api, latestSnapshot, session_id),
      },
    });
    pollTimer = setInterval(() => void refreshSidebar(), 600_000);
    void refreshSidebar();
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
    debugLog("tui plugin disposed");
    if (pollTimer) clearInterval(pollTimer);
    unregisterSidebar?.();
    dispose();
  });
};

export default { id: "opencode-codex-usage", tui: CodexQuotaTuiPlugin };
