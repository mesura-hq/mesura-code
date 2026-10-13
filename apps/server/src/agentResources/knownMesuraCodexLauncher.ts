/** One reviewed optional installation. Updates require a separately reviewed description. */
export const knownMesuraCodexLauncher = Object.freeze({
  invocation: "/usr/local/bin/codex",
  helper: "/usr/local/lib/mesura-agent-scope",
  helperSha256: "429fafc06a686d9f28cabcf5026aec8d0a2477536f098d8738622e5edc5e9cd2",
  realInvocation: "/usr/bin/codex",
  nodeSource: "/usr/lib/node_modules/@openai/codex/bin/codex.js",
  nodeSourceSha256: "61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70",
  nodeExecutable: "/usr/bin/node",
  shellExecutable: "/usr/bin/bash",
  platformPackage: "/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64",
  nativeRelativePath: "vendor/x86_64-unknown-linux-musl/bin/codex",
});
