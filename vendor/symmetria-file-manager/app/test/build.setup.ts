import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));

/**
 * Build before the suite, because the smoke test launches the real application
 * and Electron cannot run TypeScript.
 *
 * `ELECTRON_RUN_AS_NODE` is cleared here for the same reason the smoke test
 * clears it: it is set in this environment, and it makes anything that touches
 * the Electron binary behave as plain Node.
 */
export default function setup(): void {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  execFileSync("pnpm", ["run", "build"], {
    cwd: appDir,
    env,
    stdio: "inherit",
    timeout: 180_000,
  });
}
