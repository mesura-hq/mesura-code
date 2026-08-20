import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    // Bound the workers each package opens, because the package-level limit
    // cannot.
    //
    // `vp run -r --concurrency-limit N` caps how many PACKAGES run at once and
    // says nothing about the pool inside each one: vitest sizes its pool against
    // the machine's cores without knowing an identical pool runs beside it. With
    // a limit of 2 on a 16-core host that is 2 x 15 = 30 workers, roughly twice
    // the machine.
    //
    // Measured here on 2026-08-20: load average 61 on 16 cores, 29 node
    // processes at 827% aggregate CPU, 27 of 30 GiB of RAM and 14 of 15 GiB of
    // swap in use, each worker holding 480-660 MB. The host thrashed for about
    // 70 minutes and a full `test` run was aborted mid-suite at exit -1 — no
    // failing assertion, just a suite that never finished.
    //
    // 6 keeps `concurrency-limit 2` x `maxWorkers 6` at 12 of 16 cores, leaving
    // room for the desktop session. Raise it only alongside a matching drop in
    // the package limit, so the product stays under the core count.
    //
    // `maxWorkers` is the vitest 4 spelling and sits at the top of `test`.
    // `poolOptions.forks.maxForks` is the vitest 3 shape and no longer type
    // checks here — it fails as TS2769 on this call and cascades into every
    // package that imports this file.
    maxWorkers: 6,
  },
  staged: {
    // Formatter only for now — no lint or typecheck on commit.
    "*": "vp fmt",
  },
  fmt: {
    ignorePatterns: [
      ".reference",
      ".repos/**",
      ".plans",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/web/public/mockServiceWorker.js",
      "apps/web/src/lib/vendor/qrcodegen.ts",
      "apps/mobile/uniwind-types.d.ts",
      "*.icon/**",
      // Golden fixtures pin an encoded document byte for byte, in the exact
      // serialization `JSON.stringify(value, null, 2)` produces. The formatter
      // collapses short arrays onto one line, which would rewrite a pin the
      // suite then reports as a contract change.
      "packages/symmetria-broker-contract/test/fixtures/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@t3tools/client-runtime",
              message:
                "Import from an explicit @t3tools/client-runtime/* subpath. The package has no root export.",
            },
            {
              name: "@pierre/diffs/react",
              importNames: ["CodeView"],
              message:
                "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
            },
          ],
        },
      ],
      "t3code/no-global-process-runtime": "error",
      "t3code/no-inline-schema-compile": "warn",
      "t3code/no-manual-effect-runtime-in-tests": "error",
      "t3code/no-native-title-tooltip": "error",
      "t3code/namespace-node-imports": "error",
    },
    options: {
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});
