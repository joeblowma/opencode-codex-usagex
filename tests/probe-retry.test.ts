import assert from "node:assert/strict";
import { isRetryableProbeFailure, probeQuota } from "#lib/codex-usage-probe.js";
import { test } from "./test.ts";

const urlFromFetchInput = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

const whamSuccessResponse = (): Response => {
  return new Response(
    JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 81,
          reset_after_seconds: 3600,
          limit_window_seconds: 18000,
        },
        secondary_window: {
          used_percent: 9,
          reset_after_seconds: 7200,
          limit_window_seconds: 604800,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

test("probeQuota retries wham usage request once on network failure", async () => {
  let calls = 0;
  const seenUrls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls += 1;
    seenUrls.push(urlFromFetchInput(input));
    if (calls === 1) {
      throw new Error("network down");
    }
    return whamSuccessResponse();
  };

  const snapshot = await probeQuota({
    retryCount: 1,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(calls, 2);
  assert.ok(seenUrls.every((url) => url.includes("/wham/usage")));
  assert.equal(snapshot.status, "warn");
  assert.deepEqual(snapshot.used, { primary: 81, secondary: 9 });
  assert.equal(snapshot.probeTokens, 0);
});

test("probeQuota does not retry auth/http 401 failures", async () => {
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

test("probeQuota reports unusable usage payloads without model calls", async () => {
  const seenUrls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    seenUrls.push(urlFromFetchInput(input));
    return new Response(JSON.stringify({ plan_type: "plus", rate_limit: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.deepEqual(seenUrls, ["https://chatgpt.com/backend-api/wham/usage"]);
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.statusCode, "usage");
  assert.equal(snapshot.error, "no usable rate-limit data");
});

test("probeQuota extracts JSON detail for probe errors", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response(JSON.stringify({ detail: "The selected model is not available" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.statusCode, 400);
  assert.equal(snapshot.error, "The selected model is not available");
});

test("probeQuota uses a valid error message when another error field is malformed", async () => {
  const fetchImpl: typeof fetch = async () => {
    return new Response(JSON.stringify({ detail: 123, message: "Usable fallback" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(snapshot.error, "Usable fallback");
});

test("probeQuota does not retry when retry count is disabled", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    throw new Error("network down");
  };

  const snapshot = await probeQuota({
    retryCount: 0,
    fetchImpl,
    credentials: { accessToken: "token" },
  });

  assert.equal(calls, 1);
  assert.equal(snapshot.status, "error");
  assert.equal(snapshot.statusCode, "network");
});

test("isRetryableProbeFailure follows transient-only policy", () => {
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: "network" }), true);
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: "timeout" }), true);
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: 503 }), true);
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: 429 }), true);
  assert.equal(isRetryableProbeFailure({ status: "error", statusCode: 401 }), false);
  assert.equal(isRetryableProbeFailure({ status: "warn", statusCode: 503 }), false);
});
