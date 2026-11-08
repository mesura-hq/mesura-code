// @effect-diagnostics nodeBuiltinImport:off - Builds an isolated browser test fixture without an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { build } from "vite-plus";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "../..");
const webRequire = NodeModule.createRequire(NodePath.join(repositoryRoot, "apps/web/package.json"));
const legendPath = webRequire.resolve("@legendapp/list/react").replace(/react\.js$/, "react.mjs");
const react: { version: string } = webRequire("react");
const reactDom: { version: string } = webRequire("react-dom");
const legend: { version: string } = webRequire(
  NodePath.join(NodePath.dirname(legendPath), "package.json"),
);

export const timelineFixtureVersions = {
  react: react.version,
  reactDom: reactDom.version,
  legend: legend.version,
};

// Retains the independently reviewed conveyor's real wrapping geometry.
const stylesheet = `
* { box-sizing: border-box; }
html, body, #root { width: 100%; height: 100%; margin: 0; font: 14px/1.5 system-ui; }
.shell { display: flex; width: 100%; height: 100%; min-width: 0; overflow: hidden; }
.timeline-holder { height: 100%; min-height: 0; min-width: 0; }
.timeline-holder.restored { width: 1184px; }
.timeline-holder.narrow { width: 90px; flex: none; }
.timeline { width: 100%; height: 100%; min-height: 0; overflow-x: hidden; overscroll-behavior: contain; overflow-anchor: none; scrollbar-gutter: stable; }
.row { width: 100%; min-width: 0; padding: 12px; border-bottom: 1px solid #aaa; overflow-wrap: anywhere; }
.row p { margin: 8px 0; white-space: pre-wrap; }
.pane { flex: 1; min-width: 0; overflow: auto; padding: 16px; }
.pane.closed { display: none; }
`;

/** Builds only inside the caller's exclusive output directory. It launches no browser or server. */
export async function buildTimelineFindFixture(outputDirectory: string) {
  await build({
    configFile: false,
    root: outputDirectory,
    publicDir: false,
    cacheDir: NodePath.join(outputDirectory, ".cache"),
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    resolve: {
      alias: {
        react: webRequire.resolve("react"),
        "react-dom/client": webRequire.resolve("react-dom/client"),
        "@legendapp/list/react": legendPath,
        "@mesura/timeline-find-policy": NodePath.join(
          repositoryRoot,
          "apps/web/src/components/chat/timelineFindScrollPolicy.ts",
        ),
        "@mesura/thread-find-navigation": NodePath.join(
          repositoryRoot,
          "apps/web/src/components/chat/useThreadFindNavigation.ts",
        ),
        "@t3tools/shared/threadSearch": NodePath.join(
          repositoryRoot,
          "packages/shared/src/threadSearch.ts",
        ),
        "@t3tools/shared/threadFindText": NodePath.join(
          repositoryRoot,
          "packages/shared/src/threadFindText.ts",
        ),
      },
    },
    build: {
      outDir: outputDirectory,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      lib: {
        entry: NodePath.join(import.meta.dirname, "mesura-timeline.find.fixture.mjs"),
        formats: ["iife"],
        name: "TimelineFindFixture",
        fileName: () => "fixture.bundle.js",
      },
    },
  });
  const htmlPath = NodePath.join(outputDirectory, "fixture.html");
  NodeFS.writeFileSync(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><style>${stylesheet}</style><div id="root"></div><script src="./fixture.bundle.js"></script>`,
    { mode: 0o600 },
  );
  return htmlPath;
}
