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

test("sidebar panel binds quota lines reactively and follows probe updates", async () => {
  const previousAuthPath = process.env.OPENCODE_AUTH_PATH;
  // Missing auth file: probe fails fast without network.
  process.env.OPENCODE_AUTH_PATH = "/nonexistent/opencode-codex-usage-auth.json";
  const disposers: Array<() => void> = [];

  try {
    let registration:
      | {
          order?: number;
          slots: {
            sidebar_content: (context: unknown, props: { session_id: string }) => unknown;
          };
        }
      | undefined;
    const inserts: Array<{ parent: unknown; child: unknown }> = [];
    const api = {
      slots: {
        register: (input: {
          order?: number;
          slots: {
            sidebar_content: (context: unknown, props: { session_id: string }) => unknown;
          };
        }): string => {
          registration = input;
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
      state: {
        session: {
          get: () => undefined,
        },
      },
      renderer: {
        requestRender: () => undefined,
      },
    };
    const solid = {
      createElement: (kind: string) => ({ kind }),
      setProp: () => undefined,
      insert: (parent: unknown, child: unknown) => {
        inserts.push({ parent, child });
      },
      createComponent: (
        comp: (props: { sessionId: string }) => unknown,
        props: { sessionId: string },
      ) => comp(props),
    };

    await CodexQuotaTuiPlugin(api, { solid });
    assert.ok(registration, "expected slots.register to be called");

    // Simulate the host rendering the slot once, as the real host does.
    registration?.slots.sidebar_content({}, { session_id: "ses_test" });

    const dynamic = inserts.filter((entry) => typeof entry.child === "function");
    const staticTexts = inserts.filter((entry) => typeof entry.child === "string");
    // Regression: dynamic quota lines must be reactive accessors. Plain strings
    // render once and freeze because the host never re-invokes sidebar_content.
    assert.ok(dynamic.length >= 2, `expected reactive quota lines, got ${dynamic.length}`);
    assert.ok(
      staticTexts.some((entry) => entry.child === "Codex quota"),
      "expected static panel title",
    );

    // Let the background probe settle (fast auth failure, no network).
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rendered = dynamic.map((entry) => (entry.child as () => unknown)());
    assert.ok(
      rendered.some((text) => typeof text === "string" && text.includes("error")),
      `expected probe result to flow into panel, got ${JSON.stringify(rendered)}`,
    );
  } finally {
    for (const dispose of disposers) dispose();
    if (previousAuthPath === undefined) delete process.env.OPENCODE_AUTH_PATH;
    else process.env.OPENCODE_AUTH_PATH = previousAuthPath;
  }
});

test("sidebar panel aggregates assistant token usage when session totals are unavailable", async () => {
  const previousAuthPath = process.env.OPENCODE_AUTH_PATH;
  process.env.OPENCODE_AUTH_PATH = "/nonexistent/opencode-codex-usage-auth.json";
  const disposers: Array<() => void> = [];

  try {
    let registration:
      | {
          slots: {
            sidebar_content: (context: unknown, props: { session_id: string }) => unknown;
          };
        }
      | undefined;
    const inserts: Array<{ child: unknown }> = [];
    const api = {
      slots: {
        register: (input: {
          slots: {
            sidebar_content: (context: unknown, props: { session_id: string }) => unknown;
          };
        }): string => {
          registration = input;
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
      ui: { toast: () => undefined },
      state: {
        session: {
          get: () => undefined,
          messages: () => [
            { role: "user" },
            {
              role: "assistant",
              tokens: {
                input: 120,
                output: 30,
                reasoning: 10,
                cache: { read: 40, write: 5 },
              },
            },
            {
              role: "assistant",
              tokens: {
                input: 80,
                output: 20,
                reasoning: 5,
                cache: { read: 10, write: 2 },
              },
            },
          ],
        },
      },
      renderer: { requestRender: () => undefined },
    };
    const solid = {
      createElement: (kind: string) => ({ kind }),
      setProp: () => undefined,
      insert: (_parent: unknown, child: unknown) => inserts.push({ child }),
      createComponent: (
        comp: (props: { sessionId: string }) => unknown,
        props: { sessionId: string },
      ) => comp(props),
    };

    await CodexQuotaTuiPlugin(api, { solid });
    registration?.slots.sidebar_content({}, { session_id: "ses_usage" });

    const rendered = inserts
      .filter((entry) => typeof entry.child === "function")
      .map((entry) => (entry.child as () => unknown)());
    assert.ok(rendered.includes("input: 200"), JSON.stringify(rendered));
    assert.ok(rendered.includes("output: 50"), JSON.stringify(rendered));
    assert.ok(rendered.includes("cache: 50 read · 7 write"), JSON.stringify(rendered));
  } finally {
    for (const dispose of disposers) dispose();
    if (previousAuthPath === undefined) delete process.env.OPENCODE_AUTH_PATH;
    else process.env.OPENCODE_AUTH_PATH = previousAuthPath;
  }
});

test("sidebar panel aggregates step-finish usage when assistant totals are unavailable", async () => {
  const previousAuthPath = process.env.OPENCODE_AUTH_PATH;
  process.env.OPENCODE_AUTH_PATH = "/nonexistent/opencode-codex-usage-auth.json";
  const disposers: Array<() => void> = [];

  try {
    let registration:
      | {
          slots: {
            sidebar_content: (context: unknown, props: { session_id: string }) => unknown;
          };
        }
      | undefined;
    const inserts: Array<{ child: unknown }> = [];
    const api = {
      slots: {
        register: (input: {
          slots: {
            sidebar_content: (context: unknown, props: { session_id: string }) => unknown;
          };
        }): string => {
          registration = input;
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
      ui: { toast: () => undefined },
      state: {
        session: {
          get: () => undefined,
          messages: (sessionId: string) =>
            sessionId === "ses_parts" ? [{ id: "msg_assistant", role: "assistant" }] : [],
        },
        part: (messageId: string) =>
          messageId === "msg_assistant"
            ? [
                {
                  type: "step-finish",
                  tokens: {
                    input: 300,
                    output: 60,
                    reasoning: 20,
                    cache: { read: 90, write: 8 },
                  },
                },
              ]
            : [],
      },
      renderer: { requestRender: () => undefined },
    };
    const solid = {
      createElement: (kind: string) => ({ kind }),
      setProp: () => undefined,
      insert: (_parent: unknown, child: unknown) => inserts.push({ child }),
      createComponent: (
        comp: (props: { sessionId: string }) => unknown,
        props: { sessionId: string },
      ) => comp(props),
    };

    await CodexQuotaTuiPlugin(api, { solid });
    registration?.slots.sidebar_content({ theme: {} }, { session_id: "ses_parts" });

    const rendered = inserts
      .filter((entry) => typeof entry.child === "function")
      .map((entry) => (entry.child as () => unknown)());
    assert.ok(rendered.includes("input: 300"), JSON.stringify(rendered));
    assert.ok(rendered.includes("output: 60"), JSON.stringify(rendered));
    assert.ok(rendered.includes("cache: 90 read · 8 write"), JSON.stringify(rendered));
  } finally {
    for (const dispose of disposers) dispose();
    if (previousAuthPath === undefined) delete process.env.OPENCODE_AUTH_PATH;
    else process.env.OPENCODE_AUTH_PATH = previousAuthPath;
  }
});

test("tui plugin requests a render when assistant token usage changes", async () => {
  const previousAuthPath = process.env.OPENCODE_AUTH_PATH;
  process.env.OPENCODE_AUTH_PATH = "/nonexistent/opencode-codex-usage-auth.json";
  const disposers: Array<() => void> = [];
  const eventHandlers = new Map<string, (event: { properties: { sessionID: string } }) => void>();
  let renderRequests = 0;

  try {
    const api = {
      slots: { register: () => "opencode-codex-usage" },
      command: {
        register: (callback: () => RegisteredCommand[]) => {
          callback();
          const dispose = () => undefined;
          disposers.push(dispose);
          return dispose;
        },
      },
      event: {
        on: (type: string, handler: (event: { properties: { sessionID: string } }) => void) => {
          eventHandlers.set(type, handler);
          const dispose = () => eventHandlers.delete(type);
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
      ui: { toast: () => undefined },
      state: {
        session: {
          get: () => undefined,
          messages: () => [],
        },
      },
      renderer: { requestRender: () => (renderRequests += 1) },
    };
    const solid = {
      createElement: () => ({}),
      setProp: () => undefined,
      insert: () => undefined,
      createComponent: () => ({}),
    };

    await CodexQuotaTuiPlugin(api, { solid });
    const handler = eventHandlers.get("message.updated");
    assert.ok(handler, "expected message.updated subscription");
    const before = renderRequests;

    handler({ properties: { sessionID: "ses_usage" } });

    assert.equal(renderRequests, before + 1);
  } finally {
    for (const dispose of disposers) dispose();
    if (previousAuthPath === undefined) delete process.env.OPENCODE_AUTH_PATH;
    else process.env.OPENCODE_AUTH_PATH = previousAuthPath;
  }
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
        createComponent: () => ({}),
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
