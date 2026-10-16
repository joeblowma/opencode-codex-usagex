import assert from "node:assert/strict";
import * as TuiPluginModule from "#root/tui.js";
import { isQuotaProvider, nextPanelView, usageFromMessages } from "#lib/sidebar-state.js";
import {
  primaryLineText,
  secondaryLineText,
  staleLineText,
  type PanelView,
} from "#lib/sidebar-text.js";
import { test } from "./test.ts";

/**
 * Regression guard for the V2 loader: the TUI entrypoint must export a
 * definition object carrying `id` + `setup`, not a bare hook function.
 */
test("tui plugin exports a V2 plugin definition", () => {
  const definition = TuiPluginModule.default;

  assert.equal(typeof definition, "object");
  assert.equal(definition.id, "opencode-codex-usage");
  assert.equal(typeof definition.setup, "function");
});

test("tui entry keeps the quota panel for the sidebar slot", () => {
  assert.equal(typeof TuiPluginModule.CodexQuotaTuiPlugin, "object");
});

const usage = (input: number, output: number, read = 0, write = 0) => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write },
});

test("nextPanelView keeps the last good snapshot when a probe fails", () => {
  const good = { status: "ok", used: { primary: 10, secondary: 20 } };
  const previous: PanelView = { latest: good, lastGood: good };

  const next = nextPanelView(previous, { status: "error", error: "boom" });

  assert.equal(next.latest?.error, "boom");
  assert.equal(next.lastGood, good);
  assert.equal(staleLineText(next), "stale · last known");
});

test("nextPanelView promotes a successful snapshot to last good", () => {
  const previous: PanelView = { latest: undefined, lastGood: undefined };
  const good = { status: "ok", used: { primary: 10, secondary: 20 } };

  const next = nextPanelView(previous, good);

  assert.equal(next.lastGood, good);
  assert.equal(staleLineText(next), "");
});

test("usageFromMessages aggregates assistant message totals", () => {
  const total = usageFromMessages([
    { role: "user" },
    { role: "assistant", tokens: usage(100, 20) },
    { role: "assistant", tokens: usage(50, 5) },
  ]);

  assert.deepEqual(total, usage(150, 25));
});

test("usageFromMessages falls back to session totals without assistant messages", () => {
  const sessionTotals = usage(7, 3, 1, 2);

  assert.deepEqual(usageFromMessages([{ role: "user" }], sessionTotals), sessionTotals);
});

test("usageFromMessages returns undefined when there is nothing to show", () => {
  assert.equal(usageFromMessages([{ role: "user" }]), undefined);
});

test("primaryLineText renders the 5h window with a live countdown", () => {
  const view: PanelView = {
    latest: {
      status: "ok",
      used: { primary: 40, secondary: 55 },
      reset: { primary: "in 2h", secondary: "in 3d" },
      resetAtMs: { primary: 1_800_000, secondary: 259_200_000 },
    },
    lastGood: undefined,
  };

  const line = primaryLineText(view, 0);

  assert.match(line, /^5h: 60% left · /);
  assert.match(line, /30m$/);
});

test("primaryLineText reports an error when no snapshot has loaded", () => {
  const view: PanelView = { latest: undefined, lastGood: undefined };

  assert.equal(primaryLineText(view, 0), "Quota: loading…");
});

/**
 * Regression guard: a failed RPC must leave "loading…" behind. The RPC rejects
 * when credential resolution throws, and an unhandled rejection previously left
 * the panel stuck on the loading state forever.
 */
test("primaryLineText reports a failure instead of loading forever", () => {
  const view = nextPanelView(
    { latest: undefined, lastGood: undefined },
    {
      status: "error",
      statusCode: "rpc",
      error: "Request failed: 401",
    },
  );

  assert.equal(primaryLineText(view, 0), "Quota: error");
  assert.equal(secondaryLineText(view, 0), "");
});

test("quota is shown for OpenAI and unresolved providers", () => {
  assert.equal(isQuotaProvider("openai"), true);
  assert.equal(isQuotaProvider(undefined), true);
});

test("quota is hidden for other providers", () => {
  assert.equal(isQuotaProvider("anthropic"), false);
  assert.equal(isQuotaProvider("llama.cpp"), false);
});

test("secondaryLineText stays empty when the account has no weekly window", () => {
  const view: PanelView = {
    latest: { status: "ok", used: { primary: 40, secondary: null } },
    lastGood: undefined,
  };

  assert.equal(secondaryLineText(view, 0), "");
});

test("secondaryLineText renders the 7d window when present", () => {
  const view: PanelView = {
    latest: {
      status: "ok",
      used: { primary: 40, secondary: 80 },
      reset: { primary: "in 2h", secondary: "in 3d" },
    },
    lastGood: undefined,
  };

  assert.match(secondaryLineText(view, 0), /^7d: 20% left · in 3d$/);
});
