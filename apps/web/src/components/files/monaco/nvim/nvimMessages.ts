/**
 * Which of Neovim's messages are errors.
 *
 * `msg_show` carries a kind, and the kinds are Neovim's own vocabulary rather
 * than a severity: `emsg` is an error message, `echoerr` is one a script
 * raised, `wmsg` is a warning, and a great many are the empty string. Reading
 * the text for "E492" instead would be guessing, and it would be wrong in
 * every language but English.
 */
const ERROR_MESSAGE_KINDS: ReadonlySet<string> = new Set([
  "emsg",
  "echoerr",
  "lua_error",
  "rpc_error",
]);

export function isErrorMessageKind(kind: string): boolean {
  return ERROR_MESSAGE_KINDS.has(kind);
}
