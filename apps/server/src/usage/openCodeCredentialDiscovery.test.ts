import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  discoverOpenCodeCredentials,
  openCodeDataDirectories,
} from "./openCodeCredentialDiscovery.ts";

const AUTH_JSON =
  '{"zai-coding-plan":{"type":"api","key":"zai-secret-value"},' +
  '"opencode-go":{"type":"api","key":"go-secret-value"},' +
  '"openai":{"type":"oauth","access":"tok","refresh":"r","expires":1,"accountId":"acct"}}';

const ACCOUNT_JSON =
  '{"version":1,"active":{"opencode-go":"id-go"},"accounts":[{"id":"id-go",' +
  '"serviceID":"opencode-go","description":"default",' +
  '"credential":{"type":"api","key":"go-secret-value"}}]}';

function readFrom(files: Record<string, string>) {
  return (filePath: string) =>
    Effect.succeed(filePath in files ? Option.some(files[filePath]!) : Option.none<string>());
}

describe("discoverOpenCodeCredentials", () => {
  it.effect("seeds the OpenCode Go and Z.ai plans it finds", () =>
    Effect.gen(function* () {
      const found = yield* discoverOpenCodeCredentials({
        dataDir: "/data/opencode",
        readFile: readFrom({
          "/data/opencode/auth.json": AUTH_JSON,
          "/data/opencode/account.json": ACCOUNT_JSON,
        }),
      });

      const namespaces = found.map((entry) => entry.namespace).sort();
      assert.deepEqual(namespaces, ["opencode-go", "zai"]);
    }),
  );

  it.effect("reads both stores, because Z.ai lives only in the older one", () =>
    Effect.gen(function* () {
      // Verified on this machine: account.json holds opencode-go and openai;
      // auth.json holds those plus zai-coding-plan. OpenCode is mid-migration
      // between them, so a reader that knows one store is already half broken.
      const found = yield* discoverOpenCodeCredentials({
        dataDir: "/data/opencode",
        readFile: readFrom({ "/data/opencode/account.json": ACCOUNT_JSON }),
      });
      assert.deepEqual(
        found.map((entry) => entry.namespace),
        ["opencode-go"],
      );
    }),
  );

  it.effect("never claims the ChatGPT login, whose limits Codex already reports", () =>
    Effect.gen(function* () {
      const found = yield* discoverOpenCodeCredentials({
        dataDir: "/data/opencode",
        readFile: readFrom({ "/data/opencode/auth.json": AUTH_JSON }),
      });
      assert.equal(
        found.some((entry) => String(entry.namespace) === "openai"),
        false,
      );
    }),
  );

  it.effect("ignores a service it does not know without failing the pass", () =>
    Effect.gen(function* () {
      const found = yield* discoverOpenCodeCredentials({
        dataDir: "/data/opencode",
        readFile: readFrom({
          "/data/opencode/auth.json":
            '{"some-future-plan":{"type":"api","key":"k"},' +
            '"opencode-go":{"type":"api","key":"go-secret-value"}}',
        }),
      });
      assert.deepEqual(
        found.map((entry) => entry.namespace),
        ["opencode-go"],
      );
    }),
  );

  it.effect("finds nothing, and fails nothing, when OpenCode is not installed", () =>
    Effect.gen(function* () {
      const found = yield* discoverOpenCodeCredentials({
        dataDir: "/data/opencode",
        readFile: readFrom({}),
      });
      assert.deepEqual(found, []);
    }),
  );

  it("looks in the documented data directories, newest store first", () => {
    const dirs = openCodeDataDirectories({
      OPENCODE_DATA_DIR: "/explicit",
      XDG_DATA_HOME: "/xdg",
      HOME: "/home/jc",
    });
    assert.equal(dirs[0], "/explicit");
    assert.deepEqual(dirs.slice(1), ["/xdg/opencode", "/home/jc/.local/share/opencode"]);
  });
});
