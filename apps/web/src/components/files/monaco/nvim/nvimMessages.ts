/**
 * Which `msg_show` kinds are errors. Kinds are Neovim's vocabulary, not a severity (`emsg`,
 * `echoerr`, `wmsg`, often empty); matching text such as "E492" would break in other languages.
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
