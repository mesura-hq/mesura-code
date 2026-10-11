// @effect-diagnostics nodeBuiltinImport:off - A plain CLI over the browser helper.
/**
 * One-shot screenshots from a paired headless browser on this worktree's dev server.
 * For interactions, import `openMesuraPage` from `./lib/mesura-browser.ts` instead.
 *
 *   node scripts/mesura-browser.ts shot <route> <file.png> [--device phone] [--theme light]
 *     [--selector <css>] [--origin <url>] [--base-dir <dir>]
 *
 * `--selector` crops to one element: a full-page PNG costs several hundred
 * kilobytes of an agent's context, a crop a fraction of that.
 */
import * as NodeUtil from "node:util";

import {
  MESURA_DEVICES,
  MESURA_THEMES,
  type MesuraDevice,
  type MesuraTheme,
  openMesuraPage,
} from "./lib/mesura-browser.ts";

const usage =
  "usage: node scripts/mesura-browser.ts shot <route> <file.png> [--device desktop|phone] [--theme dark|light] [--selector <css>] [--origin <url>] [--base-dir <dir>]\n";

function fail(message: string): never {
  process.stderr.write(`${message}\n${usage}`);
  process.exit(2);
}

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    device: { type: "string", default: "desktop" },
    theme: { type: "string", default: "dark" },
    selector: { type: "string" },
    origin: { type: "string" },
    "base-dir": { type: "string" },
  },
});

const [command, route, file] = positionals;
if (command !== "shot" || route === undefined || file === undefined) fail("missing arguments");
// An unknown value would silently fall back to a default and produce misleading evidence.
if (!(MESURA_DEVICES as ReadonlyArray<string>).includes(values.device)) {
  fail(`unknown --device ${values.device}`);
}
if (!(MESURA_THEMES as ReadonlyArray<string>).includes(values.theme)) {
  fail(`unknown --theme ${values.theme}`);
}

const { page, origin, close } = await openMesuraPage({
  route,
  device: values.device as MesuraDevice,
  theme: values.theme as MesuraTheme,
  ...(values.origin === undefined ? {} : { origin: values.origin }),
  ...(values["base-dir"] === undefined ? {} : { baseDir: values["base-dir"] }),
});
try {
  if (values.selector === undefined) {
    await page.screenshot({ path: file });
  } else {
    const target = page.locator(values.selector).first();
    await target.waitFor({ state: "visible" });
    await target.screenshot({ path: file });
  }
  process.stdout.write(`${file} (${origin}${route})\n`);
} finally {
  await close();
}
