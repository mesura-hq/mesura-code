// @effect-diagnostics nodeBuiltinImport:off - Builds a real-sheet browser fixture without application services.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { build } from "vite-plus";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../..");
const webRequire = NodeModule.createRequire(NodePath.join(repositoryRoot, "apps/web/package.json"));
const react: { version: string } = webRequire("react");
const reactDom: { version: string } = webRequire("react-dom");
const base: { version: string } = webRequire("@base-ui/react/package.json");
export const panelFixtureVersions = {
  react: react.version,
  reactDom: reactDom.version,
  baseUi: base.version,
};

const stylesheet = `
* { box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; margin: 0; font: 14px/1.5 system-ui; }
[data-slot="sheet-backdrop"] { position: fixed; inset: 0; background: #ddd; }
[data-slot="sheet-viewport"] { position: fixed; inset: 0; display: flex; justify-content: flex-end; }
[data-slot="sheet-popup"] { position: relative; display: flex; flex-direction: column; width: min(88vw, 24rem); height: 100%; background: white; }
[data-slot="sheet-popup"][data-closed] { opacity: 0; pointer-events: none; }
[data-preview-panel-mode] { display: flex; flex-direction: column; height: 100%; width: 100%; }
[data-preview-panel-mode="inline"] { width: 420px; }
[data-right-panel-surface-content] { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
[aria-label="Open a surface"] { position: absolute; inset: 0; background: white; padding: 24px; }
[role="tree"] { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
button { min-height: 40px; }
`;

/** Builds only into an exclusively owned output directory. No server or browser runs here. */
export async function buildPanelLauncherFixture(outputDirectory: string) {
  await build({
    configFile: false,
    root: outputDirectory,
    publicDir: false,
    cacheDir: NodePath.join(outputDirectory, ".cache"),
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    resolve: {
      alias: {
        "react/jsx-runtime": webRequire.resolve("react/jsx-runtime"),
        "react/jsx-dev-runtime": webRequire.resolve("react/jsx-dev-runtime"),
        react: webRequire.resolve("react"),
        "react-dom/client": webRequire.resolve("react-dom/client"),
        "@base-ui/react": NodePath.dirname(webRequire.resolve("@base-ui/react/package.json")),
        "@mesura/right-panel-sheet": NodePath.join(
          repositoryRoot,
          "apps/web/src/components/RightPanelSheet.tsx",
        ),
        "@mesura/panel-surface-focus": NodePath.join(
          repositoryRoot,
          "apps/web/src/lib/panelSurfaceFocus.ts",
        ),
        "~": NodePath.join(repositoryRoot, "apps/web/src"),
      },
    },
    build: {
      outDir: outputDirectory,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      lib: {
        entry: NodePath.join(import.meta.dirname, "mesura-panel.launcher.fixture.mjs"),
        formats: ["iife"],
        name: "PanelLauncherFixture",
        fileName: () => "fixture.bundle.js",
      },
    },
  });
  const html = NodePath.join(outputDirectory, "fixture.html");
  NodeFS.writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${stylesheet}</style><div id="root"></div><script src="./fixture.bundle.js"></script>`,
    { mode: 0o600 },
  );
  return html;
}
