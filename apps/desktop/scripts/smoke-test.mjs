import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const desktopDir = NodePath.resolve(__dirname, "..");
const mainJs = NodePath.resolve(desktopDir, "dist-electron/main.cjs");
const preloadJs = NodePath.resolve(desktopDir, "dist-electron/preload.cjs");

const preloadSource = NodeFS.readFileSync(preloadJs, "utf8");
const preloadRuntimeRequires = [...preloadSource.matchAll(/\brequire\(["']([^"']+)["']\)/gu)].map(
  (match) => match[1],
);
const unsupportedPreloadRequires = preloadRuntimeRequires.filter(
  (moduleName) => moduleName !== "electron",
);
if (
  unsupportedPreloadRequires.length > 0 ||
  /\b(?:setImmediate|clearImmediate)\b/u.test(preloadSource)
) {
  console.error("\nDesktop preload sandbox check failed:");
  for (const moduleName of unsupportedPreloadRequires) {
    console.error(` - runtime require(${JSON.stringify(moduleName)})`);
  }
  if (/\b(?:setImmediate|clearImmediate)\b/u.test(preloadSource)) {
    console.error(" - bundled immediate scheduler collides with Electron's sandbox globals");
  }
  process.exit(1);
}

console.log("\nLaunching Electron smoke test...");

const electronCommand = resolveElectronLaunchCommand([mainJs]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: "",
    ELECTRON_ENABLE_LOGGING: "1",
  },
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const timeout = setTimeout(() => {
  child.kill();
}, 8_000);

child.on("exit", () => {
  clearTimeout(timeout);

  const fatalPatterns = [
    "Cannot find module",
    "MODULE_NOT_FOUND",
    "Refused to execute",
    "Uncaught Error",
    "Uncaught TypeError",
    "Uncaught ReferenceError",
  ];
  const failures = fatalPatterns.filter((pattern) => output.includes(pattern));

  if (failures.length > 0) {
    console.error("\nDesktop smoke test failed:");
    for (const failure of failures) {
      console.error(` - ${failure}`);
    }
    console.error("\nFull output:\n" + output);
    process.exit(1);
  }

  console.log("Desktop smoke test passed.");
  process.exit(0);
});
