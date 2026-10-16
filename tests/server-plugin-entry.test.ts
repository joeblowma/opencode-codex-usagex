import assert from "node:assert/strict";
import * as ServerPluginModule from "#root/index.js";
import { test } from "./test.ts";

/**
 * Regression guard for the V2 loader failure: the server entrypoint must
 * export a plugin *definition object* (`id` + `setup`), not the V1-era
 * factory function, which the loader rejects with
 * `Expected object at ["default"]`.
 */
test("server plugin entry exports a V2 plugin definition", () => {
  const definition = ServerPluginModule.default;

  assert.equal(typeof definition, "object");
  assert.equal(typeof definition.id, "string");
  assert.equal(typeof definition.setup, "function");
});

test("server plugin entry keeps a stable plugin id", () => {
  assert.equal(ServerPluginModule.default.id, "opencode-codex-usage");
});

test("server plugin entry exposes its factory for tests", () => {
  assert.equal(typeof ServerPluginModule.createCodexQuotaPlugin, "function");
});

test("RPC id matches the plugin id so clients resolve one namespace", async () => {
  const { CODEX_USAGE_RPC } = await import("#lib/opencode2-rpc.js");

  assert.equal(CODEX_USAGE_RPC.id, ServerPluginModule.default.id);
});
