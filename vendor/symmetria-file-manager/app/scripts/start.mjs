#!/usr/bin/env node
/**
 * Launch the built application.
 *
 * Two things this exists to get right, both of which cost an afternoon to
 * discover:
 *
 * 1. **`ELECTRON_RUN_AS_NODE` must be unset.** It is set in this operator's
 *    environment, and with it set Electron starts as a plain Node process and
 *    prints a Node version instead of opening a window.
 * 2. **The resolved path must be trimmed.** `require("electron")` returns the
 *    binary's path WITH A TRAILING NEWLINE — it reads `path.txt` and hands the
 *    contents back unchanged. Passing that to `spawn` fails with `ENOENT` for a
 *    file that plainly exists, which reads as a missing binary rather than as a
 *    stray byte. This is also why the pnpm `.bin/electron` shim appears broken
 *    in this workspace.
 *
 * Anything after `--` is passed through, so a starting directory can be given:
 *   pnpm --filter @symmetria/fm-app start -- /home/jc/projects
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const binary = String(createRequire(import.meta.url)("electron")).trim();
const appDirectory = fileURLToPath(new URL("..", import.meta.url));

const { ELECTRON_RUN_AS_NODE: _removed, ...environment } = process.env;

const child = spawn(binary, [appDirectory, ...process.argv.slice(2)], {
  env: environment,
  stdio: "inherit",
});

child.on("close", (code) => process.exit(code ?? 0));
