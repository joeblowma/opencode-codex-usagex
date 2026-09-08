import { readFile } from "node:fs/promises";
import { z } from "zod";
import { resolveAuthPath } from "./auth-path.js";
import { durationText, healthLabel, statusState } from "./quota-format.js";

type AuthFile = {
  openai?: {
    access?: string;
    accountId?: string;
  };
};

const AuthSchema = z.object({
  openai: z
    .object({
      access: z.string().optional(),
      accountId: z.string().optional(),
    })
    .optional(),
});

const ProbeErrorSchema = z.object({
  detail: z.unknown().optional(),
  error: z.unknown().optional(),
  message: z.unknown().optional(),
});

const NestedProbeErrorSchema = z.object({
  message: z.unknown().optional(),
});

const NonEmptyStringSchema = z.string().trim().min(1);

const parseAuthFile = (raw: string): AuthFile => {
  const validated = AuthSchema.safeParse(JSON.parse(raw));
  if (!validated.success) {
    throw new Error("invalid auth file shape");
  }

  return validated.data;
};

const errorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

// Dedicated quota endpoint: returns rate-limit windows without spending model quota.
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_COUNT_ENV = "OPENCODE_CODEX_QUOTA_RETRY_COUNT";
const MAX_RETRY_COUNT = 2;

type WindowPair<T> = {
  primary: T;
  secondary: T;
};

export type ProbeSnapshot = {
  status: string;
  statusCode?: number | string;
  used?: WindowPair<number | null> | string;
  reset?: WindowPair<string | null> | string;
  resetAtMs?: WindowPair<number | null>;
  windowMinutes?: WindowPair<number | null> | string;
  plan?: string;
  profile?: string;
  probeTokens?: number;
  error?: string;
};

export type ProbeQuotaOptions = {
  retryCount?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  credentials?: {
    accessToken: string;
    accountId?: string;
  };
};

const toProbeError = (
  status: string,
  detail: string,
  statusCode?: number | string,
): ProbeSnapshot => {
  const snapshot: ProbeSnapshot = {
    status,
    error: detail,
  };
  if (statusCode !== undefined) snapshot.statusCode = statusCode;
  return snapshot;
};

export const normalizeUsagePercent = (raw: string): number | null => {
  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed)) return null;

  const bounded = Math.max(0, Math.min(100, parsed));
  return Math.round(bounded);
};

export const normalizeResetValue = (raw: string, nowMs = Date.now()): string | null => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) {
    const fallback = durationText(trimmed);
    return fallback === "-" ? null : fallback;
  }

  let secondsRemaining = parsed;
  if (parsed > 1_000_000_000_000) {
    secondsRemaining = (parsed - nowMs) / 1000;
  } else if (parsed > 1_000_000_000) {
    secondsRemaining = parsed - nowMs / 1000;
  }

  const value = durationText(String(Math.max(0, Math.floor(secondsRemaining))));
  return value === "-" ? null : value;
};

// Absolute reset moment as epoch ms, so renderers can compute a live countdown
// at display time instead of freezing the relative text from probe time.
// Mirrors the unit detection in normalizeResetValue: plain numbers are seconds
// remaining, large numbers are second/ms epoch timestamps.
export const normalizeResetAtMs = (raw: string, nowMs = Date.now()): number | null => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (parsed > 1_000_000_000_000) return Math.floor(parsed);
  if (parsed > 1_000_000_000) return Math.floor(parsed * 1000);
  return Math.floor(nowMs + parsed * 1000);
};

const parseRetryCount = (raw: string | undefined, fallback = 1): number => {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, MAX_RETRY_COUNT);
};

export const resolveProbeRetryCount = (
  env: NodeJS.ProcessEnv = process.env,
  fallback = 1,
): number => {
  return parseRetryCount(env[RETRY_COUNT_ENV], fallback);
};

const parseProbeErrorDetail = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === "") return "empty error response";

  try {
    const parsed = ProbeErrorSchema.safeParse(JSON.parse(trimmed));
    if (!parsed.success) return trimmed.replace(/\s+/g, " ");

    const detail = NonEmptyStringSchema.safeParse(parsed.data.detail);
    if (detail.success) return detail.data;

    const nestedError = NestedProbeErrorSchema.safeParse(parsed.data.error);
    const nestedMessage = NonEmptyStringSchema.safeParse(
      nestedError.success ? nestedError.data.message : undefined,
    );
    if (nestedMessage.success) return nestedMessage.data;

    const message = NonEmptyStringSchema.safeParse(parsed.data.message);
    if (message.success) return message.data;
  } catch {
    // Not JSON. Fall back to compact text.
  }

  return trimmed.replace(/\s+/g, " ");
};

const shouldRetryStatusCode = (statusCode: number | string | undefined): boolean => {
  if (statusCode === "network" || statusCode === "timeout") return true;
  if (typeof statusCode === "number") {
    if (statusCode >= 500) return true;
    if (statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429) {
      return true;
    }
  }
  return false;
};

export const isRetryableProbeFailure = (snapshot: ProbeSnapshot): boolean => {
  if (statusState(snapshot.status) !== "error") return false;
  return shouldRetryStatusCode(snapshot.statusCode);
};

const percentText = (value: number | null | undefined): string => {
  if (!Number.isFinite(value ?? Number.NaN)) return "-";
  const bounded = Math.max(0, Math.min(100, Number(value)));
  return `${Math.round(bounded)}%`;
};

const windowLabel = (minutes: number | null | undefined, fallback: string): string => {
  if (!Number.isFinite(minutes ?? Number.NaN)) return fallback;
  const value = Number(minutes);
  if (value <= 0) return fallback;
  if (value % (24 * 60) === 0) return `${value / (24 * 60)}d window`;
  if (value % 60 === 0) return `${value / 60}h window`;
  return `${value}m window`;
};

const usageBar = (value: number | null | undefined, width = 20): string => {
  if (!Number.isFinite(value ?? Number.NaN)) return `[${"-".repeat(width)}]`;
  const bounded = Math.max(0, Math.min(100, Number(value)));
  const filled = Math.round((bounded / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
};

const prettyLine = (
  label: string,
  labelWidth: number,
  used: number | null | undefined,
  reset: string | null | undefined,
): string => {
  const usage = percentText(used);
  const resetText = reset && reset.trim() !== "" ? reset : "-";
  const title = `${label}:`.padEnd(labelWidth + 2);
  return `${title}${usageBar(used)} ${usage.padStart(4)}  ⏳ ${resetText}`;
};

const prettyMetaLine = (label: string, labelWidth: number, value: string): string => {
  const title = `${label}:`.padEnd(labelWidth + 2);
  return `${title}${value}`;
};

const prettyState = (status: string): string => {
  const upper = status.toUpperCase();
  if (upper === "OK") return upper;
  if (upper === "WARN") return upper;
  if (upper === "CRITICAL") return upper;
  if (upper === "ERROR") return upper;
  return "UNKNOWN";
};

const statusEmoji = (state: string): string => {
  if (state === "OK") return "✅";
  if (state === "WARN") return "⚠️";
  if (state === "CRITICAL") return "🚨";
  if (state === "ERROR") return "🚨";
  return "❓";
};

const pairOrNull = <T>(value: WindowPair<T | null> | string | undefined): WindowPair<T | null> => {
  if (typeof value !== "object" || value === null) {
    return { primary: null, secondary: null };
  }

  return {
    primary: value.primary ?? null,
    secondary: value.secondary ?? null,
  };
};

const formatPrettyProbeOutput = (snapshot: ProbeSnapshot): string => {
  const state = prettyState(snapshot.status);
  const stateWithEmoji = `${state} ${statusEmoji(state)}`;

  if (snapshot.error) {
    return [
      prettyMetaLine("codex quota probe", "codex quota probe".length, stateWithEmoji),
      prettyMetaLine("status code", "codex quota probe".length, String(snapshot.statusCode ?? "-")),
      prettyMetaLine("error", "codex quota probe".length, snapshot.error),
    ].join("\n");
  }

  const used = pairOrNull<number>(snapshot.used);
  const reset = pairOrNull<string>(snapshot.reset);
  const windowMinutes = pairOrNull<number>(snapshot.windowMinutes);

  const primaryLabel = windowLabel(windowMinutes.primary, "window A");
  const secondaryLabel = windowLabel(windowMinutes.secondary, "window B");
  const labelWidth = Math.max(
    "codex quota".length,
    "status code".length,
    "plan / profile".length,
    primaryLabel.length,
    secondaryLabel.length,
  );

  const lines = [
    prettyMetaLine("codex quota", labelWidth, stateWithEmoji),
    prettyMetaLine("status code", labelWidth, String(snapshot.statusCode ?? "-")),
    prettyMetaLine(
      "plan / profile",
      labelWidth,
      `${snapshot.plan ?? "-"} / ${snapshot.profile ?? "-"}`,
    ),
    prettyLine(primaryLabel, labelWidth, used.primary, reset.primary),
    prettyLine(secondaryLabel, labelWidth, used.secondary, reset.secondary),
  ];

  return lines.join("\n");
};

export const formatProbeOutput = (
  snapshot: ProbeSnapshot,
  options: { pretty?: boolean; printJson?: boolean } = {},
): string => {
  if (options.pretty) return formatPrettyProbeOutput(snapshot);
  return JSON.stringify(snapshot, null, options.printJson ? 2 : 0);
};

const loadCredentials = async (
  options: ProbeQuotaOptions,
): Promise<{ access: string; accountId: string } | ProbeSnapshot> => {
  if (options.credentials) {
    const access = options.credentials.accessToken.trim();
    if (access === "") {
      return toProbeError("error", "missing access token", "auth");
    }
    return { access, accountId: options.credentials.accountId ?? "" };
  }

  let access = "";
  let accountId = "";

  try {
    const authPath = resolveAuthPath();
    const authRaw = await readFile(authPath, "utf8");
    const auth = parseAuthFile(authRaw);
    access = auth.openai?.access ?? "";
    accountId = auth.openai?.accountId ?? "";

    if (access.trim() === "") {
      return toProbeError("error", "missing access token", "auth");
    }
  } catch (error) {
    const detail = errorMessage(error);
    return toProbeError("error", detail.slice(0, 120), "auth");
  }

  return { access, accountId };
};

const WhamWindowValueSchema = z.union([z.number(), z.string()]);

const WhamWindowSchema = z
  .object({
    used_percent: WhamWindowValueSchema.optional(),
    reset_at: WhamWindowValueSchema.optional(),
    reset_after_seconds: WhamWindowValueSchema.optional(),
    limit_window_seconds: WhamWindowValueSchema.optional(),
  })
  .catchall(z.unknown());

const WhamRateLimitSchema = z
  .object({
    primary_window: z.unknown().optional(),
    secondary_window: z.unknown().optional(),
    five_hour: z.unknown().optional(),
    five_hour_limit: z.unknown().optional(),
    five_hour_rate_limit: z.unknown().optional(),
    weekly: z.unknown().optional(),
    weekly_limit: z.unknown().optional(),
    weekly_rate_limit: z.unknown().optional(),
    primary: z.unknown().optional(),
    secondary: z.unknown().optional(),
  })
  .catchall(z.unknown());

const WhamUsageSchema = z
  .object({
    plan_type: z.string().optional(),
    rate_limit: WhamRateLimitSchema.optional(),
  })
  .catchall(z.unknown());

type WhamWindow = {
  used: number | null;
  reset: string | null;
  resetAtMs: number | null;
  windowMinutes: number | null;
};

const SIX_HOURS_MINUTES = 6 * 60;
const SIX_DAYS_MINUTES = 6 * 24 * 60;

const parseWhamWindow = (raw: unknown, nowMs: number): WhamWindow | null => {
  const parsed = WhamWindowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const data = parsed.data;

  const usedRaw = data.used_percent;
  const used = usedRaw === undefined ? null : normalizeUsagePercent(String(usedRaw));

  const resetRaw = data.reset_after_seconds ?? data.reset_at;
  const reset = resetRaw === undefined ? null : normalizeResetValue(String(resetRaw), nowMs);
  const resetAtMs = resetRaw === undefined ? null : normalizeResetAtMs(String(resetRaw), nowMs);

  const windowRaw = data.limit_window_seconds;
  const windowSeconds = windowRaw === undefined ? Number.NaN : Number.parseFloat(String(windowRaw));
  const windowMinutes =
    Number.isFinite(windowSeconds) && windowSeconds > 0 ? Math.round(windowSeconds / 60) : null;

  if (used === null && reset === null && resetAtMs === null && windowMinutes === null) return null;
  return { used, reset, resetAtMs, windowMinutes };
};

const classifyWhamWindows = (
  rateLimit: Record<string, unknown>,
  nowMs: number,
): { primary: WhamWindow | null; secondary: WhamWindow | null } => {
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      const value = rateLimit[key];
      if (value !== undefined && value !== null) return value;
    }
    return undefined;
  };

  let primary = parseWhamWindow(
    pick("primary_window", "five_hour", "five_hour_limit", "five_hour_rate_limit", "primary"),
    nowMs,
  );
  let secondary = parseWhamWindow(
    pick("secondary_window", "weekly", "weekly_limit", "weekly_rate_limit", "secondary"),
    nowMs,
  );

  if (primary === null || secondary === null) {
    for (const value of Object.values(rateLimit)) {
      const candidate = parseWhamWindow(value, nowMs);
      if (candidate === null || candidate.windowMinutes === null) continue;
      if (primary === null && candidate.windowMinutes <= SIX_HOURS_MINUTES) {
        primary = candidate;
        continue;
      }
      if (secondary === null && candidate.windowMinutes >= SIX_DAYS_MINUTES) {
        secondary = candidate;
      }
    }
  }

  return { primary, secondary };
};

const runWhamAttempt = async (
  access: string,
  accountId: string,
  options: {
    timeoutMs: number;
    fetchImpl: typeof fetch;
    nowMs: number;
  },
): Promise<ProbeSnapshot> => {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access}`,
    accept: "application/json",
    originator: "codex_cli_rs",
  };
  if (accountId.trim() !== "") {
    headers["chatgpt-account-id"] = accountId;
  }

  let response: Response;
  let responseText = "";

  try {
    response = await options.fetchImpl(CODEX_USAGE_URL, {
      headers,
      signal: timeoutSignal,
    });

    responseText = await response.text();
  } catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      return toProbeError("error", `request timed out after ${options.timeoutMs}ms`, "timeout");
    }

    const detail = errorMessage(error);
    return toProbeError("error", detail.slice(0, 120), "network");
  }

  if (!response.ok) {
    const detail = parseProbeErrorDetail(responseText).slice(0, 240);
    return toProbeError("error", detail, response.status);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return toProbeError("error", "invalid usage response", "usage");
  }

  const parsed = WhamUsageSchema.safeParse(payload);
  if (!parsed.success || parsed.data.rate_limit === undefined) {
    return toProbeError("error", "invalid usage response", "usage");
  }

  const { primary, secondary } = classifyWhamWindows(
    parsed.data.rate_limit as Record<string, unknown>,
    options.nowMs,
  );
  if (primary === null && secondary === null) {
    return toProbeError("error", "no usable rate-limit data", "usage");
  }

  const status = healthLabel(String(primary?.used ?? ""), String(secondary?.used ?? ""));
  const snapshot: ProbeSnapshot = {
    status,
    statusCode: 200,
    used: { primary: primary?.used ?? null, secondary: secondary?.used ?? null },
    reset: { primary: primary?.reset ?? null, secondary: secondary?.reset ?? null },
    resetAtMs: { primary: primary?.resetAtMs ?? null, secondary: secondary?.resetAtMs ?? null },
    probeTokens: 0,
  };

  const primaryMinutes = primary?.windowMinutes ?? null;
  const secondaryMinutes = secondary?.windowMinutes ?? null;
  if (primaryMinutes !== null || secondaryMinutes !== null) {
    snapshot.windowMinutes = { primary: primaryMinutes, secondary: secondaryMinutes };
  }

  const plan = parsed.data.plan_type?.trim();
  if (plan) snapshot.plan = plan;
  return snapshot;
};

export const probeQuota = async (options: ProbeQuotaOptions = {}): Promise<ProbeSnapshot> => {
  const retryCount = Math.min(
    options.retryCount ?? resolveProbeRetryCount(options.env),
    MAX_RETRY_COUNT,
  );
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = Date.now();

  const credentials = await loadCredentials(options);
  if ("status" in credentials) {
    return credentials;
  }

  // Quota-only endpoint: spends no model quota and keeps working even when
  // the model limit is exhausted.
  let snapshot = await runWhamAttempt(credentials.access, credentials.accountId, {
    timeoutMs,
    fetchImpl,
    nowMs,
  });

  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    if (!isRetryableProbeFailure(snapshot)) break;
    snapshot = await runWhamAttempt(credentials.access, credentials.accountId, {
      timeoutMs,
      fetchImpl,
      nowMs,
    });
  }

  return snapshot;
};

export const probeQuotaLine = async (): Promise<string> => {
  const snapshot = await probeQuota();
  return formatProbeOutput(snapshot);
};
