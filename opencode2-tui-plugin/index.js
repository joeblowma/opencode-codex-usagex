/**
 * Bridge for the OpenCode 2 TUI plugin resolver.
 *
 * The TUI loader is configured with a directory path, which would otherwise
 * resolve to the package's server entry (`index.ts`). This shim points it at
 * the TUI entry so `tui.json` can register the sidebar panel.
 */
export { default } from "../dist/tui.js";
