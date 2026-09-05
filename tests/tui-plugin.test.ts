import assert from "node:assert/strict";
import TuiPluginModule from "#root/tui.js";
import { CodexQuotaTuiPlugin } from "#root/tui.js";
import { test } from "./test.ts";

test("tui path plugin exports a stable id", () => {
  assert.equal(TuiPluginModule.id, "opencode-codex-usage");
});

type RegisteredCommand = {
  title: string;
  value: string;
  description: string;
  category: string;
  slash: { name: string };
  onSelect: () => void;
};

test("tui plugin registers codex usage as a slash command", async () => {
  let commands: RegisteredCommand[] = [];
  const disposers: Array<() => void> = [];
  const api = {
    command: {
      register: (callback: () => RegisteredCommand[]) => {
        commands = callback();
        const dispose = () => undefined;
        disposers.push(dispose);
        return dispose;
      },
    },
    lifecycle: {
      onDispose: (dispose: () => void) => {
        disposers.push(dispose);
        return () => undefined;
      },
    },
    ui: {
      toast: () => undefined,
    },
  };

  await CodexQuotaTuiPlugin(api);

  assert.deepEqual(commands, [
    {
      title: "Codex usage",
      value: "codex-usage",
      description: "Show Codex quota",
      category: "Codex",
      slash: { name: "codex-usage" },
      onSelect: commands[0]?.onSelect,
    },
  ]);
  assert.equal(typeof commands[0]?.onSelect, "function");
});

test("tui plugin dispose tolerates host slot ids (no unregister function)", async () => {
  const previousAuthPath = process.env.OPENCODE_AUTH_PATH;
  // Point the background probe at a missing auth file so no network is touched.
  process.env.OPENCODE_AUTH_PATH = "/nonexistent/opencode-codex-usage-auth.json";

  try {
    const disposers: Array<() => void> = [];
    let slotRegistered = false;
    const api = {
      slots: {
        // Host contract: register() returns a slot id string, not a disposer.
        register: (): string => {
          slotRegistered = true;
          return "opencode-codex-usage";
        },
      },
      command: {
        register: (callback: () => RegisteredCommand[]) => {
          callback();
          const dispose = () => undefined;
          disposers.push(dispose);
          return dispose;
        },
      },
      lifecycle: {
        onDispose: (dispose: () => void) => {
          disposers.push(dispose);
          return () => undefined;
        },
      },
      ui: {
        toast: () => undefined,
      },
    };

    await CodexQuotaTuiPlugin(api, {
      // @opentui/solid needs Bun FFI and cannot load under node --test.
      solid: {
        createElement: () => ({}),
        setProp: () => undefined,
        insert: () => undefined,
      },
    });

    assert.equal(slotRegistered, true);
    // Regression: dispose used to call the slot id string as a function and
    // throw "unregisterSidebar is not a function".
    for (const dispose of disposers) dispose();
  } finally {
    if (previousAuthPath === undefined) delete process.env.OPENCODE_AUTH_PATH;
    else process.env.OPENCODE_AUTH_PATH = previousAuthPath;
  }
});
