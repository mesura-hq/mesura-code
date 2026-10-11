// Entry point: `collectProjectIconCandidates` and `validateProjectIconCandidate`,
// the bounded local scan behind icon previews and searches. Carried over from
// the prototype's suite, which the production discovery service replaced.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  collectProjectIconCandidates,
  validateProjectIconCandidate,
} from "./ProjectIconCandidates.ts";

it.layer(NodeServices.layer)("project icon candidates", (it) => {
  it.effect("finds nested brand assets and skips dependencies and symlink directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-icon-candidates-" });
      const write = Effect.fnUntraced(function* (relative: string) {
        const target = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFileString(target, "<svg/>");
      });
      const icon = "web/public/brand-logo.svg";
      yield* write(icon);
      yield* write("node_modules/example/logo.svg");
      yield* write(".t3/brand-logo.svg");
      yield* write("docs/screenshot.png");
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-outside-icon-" });
      yield* fs.writeFileString(`${outside}/logo.svg`, "<svg/>");
      yield* fs.symlink(outside, `${root}/linked-assets`);
      const candidates = yield* Effect.tryPromise(() => collectProjectIconCandidates(root));
      expect(candidates.map((candidate) => candidate.path)).toEqual([icon]);
      expect(yield* Effect.tryPromise(() => validateProjectIconCandidate(root, icon))).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          validateProjectIconCandidate(root, "linked-assets/logo.svg"),
        ),
      ).toBe(false);
    }).pipe(Effect.scoped),
  );
});
