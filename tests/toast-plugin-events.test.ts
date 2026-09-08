import assert from "node:assert/strict";
import {
  CodexQuotaToastPlugin,
  isCommandExecutedEvent,
  isCodexUsageCommand,
  isFileWatcherEvent,
  isSessionDeletedEvent,
  isSessionActivityEvent,
  isSessionCreatedEvent,
} from "#lib/codex-usage-toast-plugin.js";
import { test } from "./test.ts";

const pluginContext = () => ({
  worktree: "/tmp/worktree",
  client: {
    tui: {
      showToast: async () => undefined,
    },
    app: {
      log: async () => undefined,
    },
  },
});

test("matches observed session lifecycle event types", () => {
  assert.equal(isSessionCreatedEvent("session.created"), true);
  assert.equal(isSessionCreatedEvent("session.updated"), false);

  assert.equal(isSessionActivityEvent("session.updated"), true);
  assert.equal(isSessionActivityEvent("session.status"), true);
  assert.equal(isSessionActivityEvent("server.connected"), false);
});

test("matches documented session deletion event type", () => {
  assert.equal(isSessionDeletedEvent("session.deleted"), true);
  assert.equal(isSessionDeletedEvent("server.instance.disposed"), false);
});

test("matches command executed event type", () => {
  assert.equal(isCommandExecutedEvent("command.executed"), true);
  assert.equal(isCommandExecutedEvent("message.updated"), false);
});

test("matches codex usage command names", () => {
  assert.equal(isCodexUsageCommand("/codex-usage"), true);
  assert.equal(isCodexUsageCommand("codex-usage"), true);
  assert.equal(isCodexUsageCommand("/other"), false);
  assert.equal(isCodexUsageCommand(undefined), false);
});

test("server plugin does not register codex usage as a session command", async () => {
  const plugin = CodexQuotaToastPlugin(pluginContext());
  const config: { command?: Record<string, { description: string; template: string }> } = {};

  await plugin.config?.(config);
  plugin.dispose?.();

  assert.equal(config.command?.["codex-usage"], undefined);
});

test("server plugin does not intercept codex usage session command", async () => {
  const plugin = CodexQuotaToastPlugin(pluginContext());
  const hasHook = "command.execute.before" in plugin;
  plugin.dispose?.();

  assert.equal(hasHook, false);
});

test("matches file watcher namespace event types", () => {
  assert.equal(isFileWatcherEvent("file.watcher.updated"), true);
  assert.equal(isFileWatcherEvent("file.watcher.created"), true);
  assert.equal(isFileWatcherEvent("file.edited"), false);
});
