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
      // The vendored file manager's suites run under their own vitest configs
      // through their package `test` scripts; the root config has no DOM.
      "**/vendor/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
    ],
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
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
      "*.icon/**",
      // Golden fixtures pin an encoded document byte for byte, in the exact
      // serialization `JSON.stringify(value, null, 2)` produces. The formatter
      // collapses short arrays onto one line, which would rewrite a pin the
      // suite then reports as a contract change.
      "packages/symmetria-broker-contract/test/fixtures/**",
      // Generated JSON Schema artifacts, written in that same serialization and
      // hashed byte for byte into the contract checksum a second repository
      // pins. `vp run generate` owns these bytes; a formatter pass would move
      // the checksum without any schema having changed.
      "packages/symmetria-broker-contract/schema/**",
      // Real documents as the planning skill writes them. The formatter would
      // turn the phases block's ```json fence into ````json and collapse its
      // arrays, so the parser would be tested against text no skill produces.
      "packages/shared/src/fixtures/**",
      // The vendored Symmetria File Manager subtree keeps its own formatter
      // (biome); formatting it here would make every subtree sync a conflict.
      "vendor/**",
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
      // The vendored Symmetria File Manager subtree is linted in its own
      // repository (biome + oxlint); see the fmt ignore above. Both forms,
      // like `.repos`: oxlint needs the bare one to skip the directory itself.
      "vendor",
      "vendor/**",
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
    overrides: [
      {
        // The one place that reads the host platform to seed the injected references.
        files: ["packages/shared/src/hostProcess.ts"],
        rules: { "t3code/no-global-process-runtime": "off" },
      },
      {
        files: ["apps/mobile/src/**"],
        rules: { "t3code/no-mobile-uniwind-theme-escape-hatches": "error" },
      },
      {
        // Code that runs on Hermes. It has no ES2023 change-array-by-copy methods, and
        // tsconfig targets ESNext, so only lint stands between a call and a fatal launch.
        // Tests run on Node and are exempt.
        files: [
          "apps/mobile/src/**",
          "packages/client-runtime/src/**",
          "packages/contracts/src/**",
          "packages/shared/src/**",
        ],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "t3code/no-hermes-unsupported-array-methods": "error" },
      },
      {
        // Reviewed native and third-party interop boundaries that cannot consume a className.
        files: [
          "apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx",
          "apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx",
          "apps/mobile/src/features/files/FileMarkdownPreview.tsx",
          "apps/mobile/src/features/files/SourceFileSurface.tsx",
          "apps/mobile/src/features/files/AttachmentFileScreen.tsx",
          "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
          "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
          "apps/mobile/src/features/home/HomeHeader.tsx",
          "apps/mobile/src/features/review/ReviewSheet.tsx",
          "apps/mobile/src/features/review/useNativeReviewDiffBridge.ts",
          "apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx",
          "apps/mobile/src/features/settings/appearance/components/AppearancePreviews.tsx",
          "apps/mobile/src/features/threads/GitActionProgressOverlay.tsx",
          "apps/mobile/src/features/threads/NewTaskDraftScreen.tsx",
          "apps/mobile/src/features/threads/ThreadComposer.tsx",
          "apps/mobile/src/features/threads/ThreadFeed.tsx",
          "apps/mobile/src/features/review/ReviewCommentCard.tsx",
          "apps/mobile/src/features/threads/ThreadSettingsSheet.tsx",
          "apps/mobile/src/features/threads/git/GitOverviewSheet.tsx",
          "apps/mobile/src/features/threads/thread-list-items.tsx",
          "apps/mobile/src/features/threads/thread-list-v2-items.tsx",
          "apps/mobile/src/lib/useMobileNavigationTheme.ts",
          "apps/mobile/src/native/T3ComposerEditor.ios.tsx",
          "apps/mobile/src/native/T3ComposerEditor.native.tsx",
        ],
        rules: {
          "t3code/no-mobile-uniwind-theme-escape-hatches": ["error", { allowUniwindTheme: true }],
        },
      },
      // Legacy manual Effect runners tracked as debt: no net-new occurrences.
      // Lower a ceiling when you migrate a file, and delete its entry at zero.
      ...Object.entries({
        "apps/server/src/orchestration/Layers/CheckpointReactor.test.ts": 42,
        "apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts": 5,
        "apps/server/src/orchestration/Layers/OrchestrationReactor.test.ts": 4,
        "apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts": 66,
        "apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts": 29,
        "apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts": 2,
        "apps/server/src/orchestration/commandInvariants.test.ts": 5,
        "apps/server/src/orchestration/projector.test.ts": 20,
        "apps/server/src/provider/Layers/CodexAdapter.test.ts": 1,
        "apps/server/src/provider/Layers/CodexSessionRuntime.test.ts": 5,
        "apps/server/src/provider/Layers/CursorAdapter.test.ts": 1,
        "apps/server/src/provider/Layers/CursorProvider.test.ts": 1,
        "apps/server/src/provider/Layers/ProviderService.test.ts": 2,
        "apps/server/src/provider/Layers/ProviderSessionReaper.test.ts": 12,
        "apps/server/src/provider/acp/CursorAcpSupport.test.ts": 1,
      }).map(([file, maxOccurrences]) => {
        const rule: ["error", { maxOccurrences: number }] = ["error", { maxOccurrences }];
        return { files: [file], rules: { "t3code/no-manual-effect-runtime-in-tests": rule } };
      }),
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      // Revisit once Oxlint's tsgolint path can integrate with @effect/tsgo diagnostics.
      typeAware: false,
      typeCheck: false,
    },
  },
});
