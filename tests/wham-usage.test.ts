import assert from "node:assert/strict";
import { probeQuota } from "#lib/codex-usage-probe.js";
import { test } from "./test.ts";

const urlFromFetchInput = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const whamResponse = (payload: unknown, status = 200): Response => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
};

const fullPayload = () => ({
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 81,
      reset_after_seconds: 3600,
      limit_window_seconds: 18000,
    },
    secondary_window: {
      used_percent: 9,
      reset_after_seconds: 604800,
      limit_window_seconds: 604800,
    },
  },
});

test("probeQuota reads quota from wham usage without model calls", async () => {
  const seenUrls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    seenUrls.push(urlFromFetchInput(input));
    return whamResponse(fullPayload());
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token", accountId: "acc-1" },
  });

  assert.deepEqual(seenUrls, ["https://chatgpt.com/backend-api/wham/usage"]);
  assert.equal(snapshot.status, "warn");
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.plan, "plus");
  assert.deepEqual(snapshot.used, { primary: 81, secondary: 9 });
  assert.deepEqual(snapshot.reset, { primary: "1h0m", secondary: "7d0h" });
  assert.deepEqual(snapshot.windowMinutes, { primary: 300, secondary: 10080 });
  assert.equal(snapshot.probeTokens, 0);
  assert.equal(snapshot.error, undefined);
});

test("probeQuota resolves epoch reset_at timestamps", async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 5400;
  const fetchImpl: typeof fetch = async () => {
    return whamResponse({
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: resetAt, limit_window_seconds: 18000 },
        secondary_window: {
          used_percent: 5,
          reset_after_seconds: 60,
          limit_window_seconds: 604800,
        },
      },
    });
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
    timeoutMs: 5000,
  });

  // reset_at is wall-clock based; allow a small drift from Date.now().
  assert.ok(snapshot.reset !== undefined && typeof snapshot.reset === "object");
  const reset = snapshot.reset as { primary: string | null; secondary: string | null };
  assert.ok(reset.primary === "1h30m" || reset.primary === "1h29m", reset.primary ?? "null");
  assert.equal(reset.secondary, "1m");
  assert.equal(snapshot.status, "ok");
});

test("probeQuota classifies windows by duration without canonical keys", async () => {
  const fetchImpl: typeof fetch = async () => {
    return whamResponse({
      plan_type: "pro",
      rate_limit: {
        custom_a: { used_percent: "81.6", reset_after_seconds: 3600, limit_window_seconds: 18000 },
        custom_b: { used_percent: 9, reset_after_seconds: 7200, limit_window_seconds: 604800 },
      },
    });
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(snapshot.status, "warn");
  assert.equal(snapshot.plan, "pro");
  assert.deepEqual(snapshot.used, { primary: 82, secondary: 9 });
  assert.deepEqual(snapshot.windowMinutes, { primary: 300, secondary: 10080 });
});

test("probeQuota keeps partial windows when one lane is missing", async () => {
  const fetchImpl: typeof fetch = async () => {
    return whamResponse({
      rate_limit: {
        primary_window: { used_percent: 81, reset_after_seconds: 3600 },
      },
    });
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.deepEqual(snapshot.used, { primary: 81, secondary: null });
  assert.equal(snapshot.status, "unknown");
  assert.equal(snapshot.statusCode, 200);
});

test("probeQuota does not fall back to legacy probe on wham auth failures", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  };

  const snapshot = await probeQuota({
    retryCount: 2,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(calls, 1);
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.statusCode, 401);
});

test("probeQuota surfaces wham rate limits without model calls", async () => {
  const seenUrls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    seenUrls.push(urlFromFetchInput(input));
    return whamResponse({ detail: "limit reached" }, 429);
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.deepEqual(seenUrls, ["https://chatgpt.com/backend-api/wham/usage"]);
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.statusCode, 429);
  assert.equal(snapshot.error, "limit reached");
});
