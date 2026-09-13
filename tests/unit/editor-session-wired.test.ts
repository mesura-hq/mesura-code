// @effect-diagnostics nodeBuiltinImport:off - reads repository files as an external consumer.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

import { repositoryRoot } from "./contractHarness.ts";

/**
 * The editor session's wiring, held in place by reading the source.
 *
 * Everything here broke silently at least once while it was built, and not one
 * of the breakages was reachable from a test that runs the code. That is the
 * whole justification for a guard that reads text instead of behaviour, and it
 * is the same justification `monaco-file-surface-wired.test.ts` gives.
 *
 * Four kinds of silence, in the order they cost the most time:
 *
 * - **A handler missing from `ws.ts` compiles.** The RPC group is typed by the
 *   contract, so the type checker is satisfied by the handlers that are there;
 *   the socket then answers the missing method with method-not-found at
 *   runtime, and the client shows an editor that takes no keys.
 * - **The manager layer missing from `server.ts` compiles too**, for the same
 *   reason one level up. The server starts and every editor call fails.
 * - **A host-plugin option left out changes nothing visible on the server.**
 *   It shifts the grid one column against the buffer, and the classification
 *   that finds flash labels then reads the whole line as text that is not
 *   there. With line numbers left on, one jump produced 132 phantom labels in
 *   the prototype against the 30 that were real.
 * - **A key rule is invisible until the wrong key is pressed.** Meta has to
 *   pass through to the application or the file picker and the command palette
 *   die wherever the editor holds focus.
 *
 * The scope assertions are the exception and they are deliberate: a missing
 * entry in `RpcAuthorization.ts` fails the type check, so those cannot rot.
 * They are here as documentation of which scope the editor borrows and why —
 * a session is a subprocess on the developer's machine reading and writing
 * their files, which is the terminal's authority rather than a new one.
 *
 * Assertions are on substrings, never on counts, so upstream adding a method
 * or an option beside ours does not fail a guard that has nothing to say about
 * it.
 */

const read = (relativePath: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, relativePath), "utf8");

/** The seven methods the editor session contract defines, by their key. */
const EDITOR_SESSION_METHODS = [
  "editorSessionOpen",
  "editorSessionAttach",
  "editorSessionInput",
  "editorSessionViewport",
  "editorSessionSetCursor",
  "editorSessionReplaceText",
  "editorSessionClose",
] as const;

it("defines exactly the editor session methods the rest of this file assumes", () => {
  const rpc = read("packages/contracts/src/rpc.ts");

  // The list above is duplicated from the contract on purpose: a guard that
  // derived it from the same file it checks would pass for a method nobody
  // implemented. This assertion is what keeps the duplicate honest — a method
  // added to the contract and not added here fails right here, naming itself.
  const declared = [...rpc.matchAll(/^ {2}(editorSession[A-Za-z]+):/gm)].map((match) => match[1]);

  assert.deepStrictEqual(
    declared,
    [...EDITOR_SESSION_METHODS],
    "the editor session contract changed: add the new method to this guard, then to ws.ts and RpcAuthorization.ts",
  );
});

it("answers every editor session method on the socket", () => {
  const ws = read("apps/server/src/ws.ts");

  for (const method of EDITOR_SESSION_METHODS) {
    assert.include(
      ws,
      `[WS_METHODS.${method}]:`,
      `ws.ts has no handler for ${method}: the group still type-checks and the socket answers the call with method-not-found`,
    );
  }
});

it("provides the editor session manager to the server", () => {
  const server = read("apps/server/src/server.ts");

  assert.include(
    server,
    'import * as EditorSessionManager from "./editor/Manager.ts"',
    "server.ts no longer imports the editor session manager",
  );
  assert.include(
    server,
    "EditorSessionManager.layer",
    "server.ts no longer builds the editor session layer",
  );
  assert.match(
    server,
    /Layer\.mergeAll\([^)]*EditorSessionLayerLive/s,
    "the editor session layer is built and not merged into the server's layer: every editor call then fails at runtime on a server that started cleanly",
  );
});

it("borrows the terminal's authority for every editor session method", () => {
  const authorization = read("apps/server/src/auth/RpcAuthorization.ts");

  for (const method of EDITOR_SESSION_METHODS) {
    assert.include(
      authorization,
      `[WS_METHODS.${method}]: AuthTerminalOperateScope`,
      `${method} is not mapped to the terminal scope: a session is a subprocess reading and writing the developer's files, which is that authority and not a new one`,
    );
  }
});

it("hands the file panel's surface the thread and the setting it needs", () => {
  const panel = read("apps/web/src/components/files/FilePreviewPanel.tsx");

  const start = panel.indexOf("<MonacoFileSurface");
  assert.notStrictEqual(start, -1, "FilePreviewPanel no longer mounts MonacoFileSurface");
  const element = panel.slice(start, panel.indexOf("/>", start) + 2);

  // A session belongs to a thread, so without the ref there is nothing to open
  // one against and the surface falls back to the plain editor in silence.
  assert.include(
    element,
    "threadRef={threadRef}",
    "the surface gets no thread ref: there is nothing to open a session against and the panel silently stays a plain editor",
  );
  assert.include(
    element,
    "modalEditing={modalEditing}",
    "the surface gets no modalEditing prop: the setting is then written, read and ignored",
  );
});

/**
 * The options that keep grid column N equal to buffer column N.
 *
 * A cell is read as text that is not there when its character differs from the
 * buffer's at that column, which is how flash labels are found. Anything
 * Neovim paints in the margin shifts every column on the line; `list` and
 * `conceallevel` break the same equality from the other side, by painting
 * where the buffer holds a space and by hiding buffer text behind something
 * narrower.
 */
const COLUMN_PRESERVING_OPTIONS = [
  [
    "number",
    "line numbers shift every column: this is the option that produced 132 phantom labels",
  ],
  ["relativenumber", "relative line numbers shift every column, the same as 'number'"],
  ["signcolumn", "the sign column shifts every column on every line"],
  ["foldcolumn", "the fold column shifts every column on every line"],
  ["numberwidth", "a wide number column shifts every column even with 'number' off"],
  ["list", "listchars paint a character where the buffer holds a space or a tab"],
  ["conceallevel", "conceal replaces buffer text with something of a different width"],
] as const;

it("forces the gutter off, as a window option and as a global", () => {
  const plugin = read("apps/server/src/editor/hostPlugin.ts");

  for (const [option, why] of COLUMN_PRESERVING_OPTIONS) {
    assert.include(
      plugin,
      `vim.wo.${option} = `,
      `the host plugin does not own window-local '${option}': ${why}`,
    );
    assert.include(
      plugin,
      `vim.opt.${option} = `,
      `the host plugin does not set '${option}' globally: a window opened before the autocommand runs starts wrong and is corrected a frame later`,
    );
  }
});

it("takes the scrolling away from Neovim", () => {
  const plugin = read("apps/server/src/editor/hostPlugin.ts");

  // The host decides the top line. With a scroll offset Neovim drags the
  // viewport of its own accord and the two fight, which the developer sees as
  // a panel that scrolls back a line under them.
  assert.include(
    plugin,
    "vim.wo.scrolloff = 0",
    "Neovim keeps scrolling on its own and fights the host for the top line",
  );
  assert.include(
    plugin,
    "vim.opt.scrolloff = 0",
    "a window opened before the autocommand runs starts with the configuration's own scrolloff",
  );
  assert.include(plugin, "vim.wo.sidescrolloff = 0", "the same fight, horizontally");
});

it("stops the highlighter and keeps the parser", () => {
  const plugin = read("apps/server/src/editor/hostPlugin.ts");

  assert.include(
    plugin,
    'vim.opt.syntax = "off"',
    "syntax highlighting is on: every cell then carries a highlight and the decoration stream becomes the whole viewport on every keystroke, for colours Monaco already draws",
  );
  assert.include(
    plugin,
    "vim.treesitter.stop",
    "the treesitter highlighter is not stopped, so the decoration stream stays the size of the viewport",
  );
  assert.notInclude(
    plugin,
    "vim.treesitter.stop_parser",
    "only the highlighter may be stopped: flash's treesitter mode queries the tree, and stopping the parser breaks the jump this whole surface exists to show",
  );
});

it("answers `:w` itself rather than letting Neovim write the file", () => {
  const plugin = read("apps/server/src/editor/hostPlugin.ts");

  // The host owns the file on disk — it holds the save coordinator, the
  // debounce and the retention record that tells our own writes from the
  // agent's. A Neovim that wrote the buffer itself would land underneath all
  // three, and the panel would report a save it never made.
  assert.include(
    plugin,
    'nvim_create_autocmd("BufWriteCmd"',
    "`:w` is not intercepted: Neovim writes the file behind the save coordinator's back and the panel reports a save it never made",
  );
});

it("lets the application keep its own shortcuts", () => {
  const keymap = read("apps/web/src/components/files/monaco/nvim/nvimKeymap.ts");

  // Behaviour for both of these is proved properly in
  // `apps/web/src/components/files/monaco/nvim/nvimKeymap.test.ts`, which
  // calls the function. This holds the two rules whose loss is silent in a way
  // a reader of the diff would not notice: both look like simplifications.
  assert.include(
    keymap,
    "if (event.metaKey) return null;",
    "Meta no longer passes through: Neovim's `<D-` notation would swallow the file picker and the command palette wherever the editor has focus",
  );
  // The whole expression, not `special !== undefined` alone: that substring
  // also appears two lines further down, where it decides whether a key has a
  // name at all, and an assertion on it passed with the Shift rule deleted.
  assert.include(
    keymap,
    "event.shiftKey && special !== undefined",
    "Shift is treated as a modifier for printable keys: a shifted character already arrives shifted in `event.key`, so `<S-J>` reaches Neovim instead of `J`",
  );
  assert.include(
    keymap,
    'event.key !== "Escape"',
    "`<S-Esc>` now reaches Neovim: a Shift held a moment too long then strands the developer in insert mode",
  );
});
