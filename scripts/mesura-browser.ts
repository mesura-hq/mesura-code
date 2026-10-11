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

import { type MesuraDevice, openMesuraPage } from "./lib/mesura-browser.ts";

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
if (command !== "shot" || route === undefined || file === undefined) {
  process.stderr.write(
    "usage: node scripts/mesura-browser.ts shot <route> <file.png> [--device desktop|phone] [--theme dark|light] [--selector <css>] [--origin <url>] [--base-dir <dir>]\n",
  );
  process.exit(2);
}

const { page, origin, close } = await openMesuraPage({
  route,
  device: values.device as MesuraDevice,
  theme: values.theme === "light" ? "light" : "dark",
  ...(values.origin === undefined ? {} : { origin: values.origin }),
  ...(values["base-dir"] === undefined ? {} : { baseDir: values["base-dir"] }),
});
try {
  await page.waitForLoadState("networkidle");
  if (values.selector === undefined) {
    await page.screenshot({ path: file });
  } else {
    await page.locator(values.selector).first().screenshot({ path: file });
  }
  process.stdout.write(`${file} (${origin}${route})\n`);
} finally {
  await close();
}
