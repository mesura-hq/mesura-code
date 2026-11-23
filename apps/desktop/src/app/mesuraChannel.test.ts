// resolveMesuraChannel({ isPackaged, appPath }) reads the packaged identity before Electron is ready.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { resolveUserDataPath } from "./DesktopUserData.ts";
import { MESURA_DESKTOP_CHANNEL_IDENTITY } from "../../../../scripts/lib/brand-assets.ts";
import { withSharedUrlSchemeOwnership } from "./mesuraChannel.ts";

const makePackagedFixture = Effect.fn("test.makePackagedChannelFixture")(function* (
  mesuraChannel?: "stable" | "dev" | "lab",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-packaged-channel-" });
  const appPath = path.join(root, "app");
  const homeDirectory = path.join(root, "home");
  yield* fs.makeDirectory(appPath);
  yield* fs.writeFileString(path.join(appPath, "package.json"), JSON.stringify({ mesuraChannel }));
  return { appPath, homeDirectory, isPackaged: true } as const;
});

const packagedEnvironment = (
  fixture: Effect.Success<ReturnType<typeof makePackagedFixture>>,
  env: Record<string, string> = {},
) =>
  DesktopEnvironment.layer({
    ...fixture,
    dirname: fixture.appPath,
    platform: "linux",
    processArch: "x64",
    appVersion: "1.2.3",
    resourcesPath: fixture.appPath,
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(DesktopConfig.layerTest(env)));

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "packaged channel identity",
  (it) => {
    it.effect("resolves the stable channel for both legacy and explicitly stable manifests", () =>
      Effect.gen(function* () {
        const { resolveMesuraChannel } = yield* Effect.promise(() => import("./mesuraChannel.ts"));

        for (const packagedField of [undefined, "stable"] as const) {
          const fixture = yield* makePackagedFixture(packagedField);
          const identity = resolveMesuraChannel(fixture);
          assert.include(identity, {
            userDataDirName: "mesura-code",
            homeDirName: ".mesura-code",
            desktopEntryName: "mesura-code.desktop",
            wmClass: "mesura-code",
            backendPort: 3773,
            tailscaleServePort: 443,
          });
        }
      }),
    );

    it.effect.each([
      {
        channel: "dev" as const,
        slug: "mesura-code-channel-dev",
        displayName: "Mesura Code Dev",
        backendPort: 3783,
        tailscalePort: 8783,
      },
      {
        channel: "lab" as const,
        slug: "mesura-code-channel-lab",
        displayName: "Mesura Code Lab",
        backendPort: 3793,
        tailscalePort: 8793,
      },
    ])("starts a packaged $channel desktop with its own identity and ports", (expected) =>
      Effect.gen(function* () {
        const fixture = yield* makePackagedFixture(expected.channel);
        yield* Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const path = yield* Path.Path;
          const fs = yield* FileSystem.FileSystem;
          const profile = yield* resolveUserDataPath(environment);
          const settings = yield* DesktopAppSettings.make;

          assert.deepStrictEqual(
            {
              profile,
              home: environment.baseDir,
              stateDir: environment.stateDir,
              desktopEntry: environment.linuxDesktopEntryName,
              windowClass: environment.linuxWmClass,
              displayName: environment.displayName,
              backendPort: Option.getOrUndefined(environment.configuredBackendPort),
              tailscalePort: (yield* settings.load).tailscaleServePort,
            },
            {
              profile: path.join(fixture.homeDirectory, ".config", expected.slug),
              home: path.join(fixture.homeDirectory, `.${expected.slug}`),
              stateDir: path.join(fixture.homeDirectory, `.${expected.slug}`, "userdata"),
              desktopEntry: `${expected.slug}.desktop`,
              windowClass: expected.slug,
              displayName: expected.displayName,
              backendPort: expected.backendPort,
              tailscalePort: expected.tailscalePort,
            },
          );

          yield* fs.makeDirectory(environment.stateDir, { recursive: true });
          yield* fs.writeFileString(environment.desktopSettingsPath, '{"tailscaleServePort":9443}');
          assert.equal((yield* settings.load).tailscaleServePort, 9443);
        }).pipe(Effect.provide(packagedEnvironment(fixture)));
      }),
    );

    it.effect("honors explicit desktop home and backend port overrides in packaged Lab", () =>
      Effect.gen(function* () {
        const fixture = yield* makePackagedFixture("lab");
        const path = yield* Path.Path;
        const customHome = path.join(fixture.homeDirectory, "custom-home");
        const defaults = yield* DesktopEnvironment.DesktopEnvironment.pipe(
          Effect.provide(packagedEnvironment(fixture)),
        );
        const overridden = yield* DesktopEnvironment.DesktopEnvironment.pipe(
          Effect.provide(
            packagedEnvironment(fixture, { T3CODE_HOME: customHome, T3CODE_PORT: "4100" }),
          ),
        );

        assert.deepStrictEqual(
          [overridden.baseDir, Option.getOrUndefined(overridden.configuredBackendPort)],
          [customHome, 4100],
        );
        assert.deepStrictEqual(
          [defaults.baseDir, Option.getOrUndefined(defaults.configuredBackendPort)],
          [path.join(fixture.homeDirectory, ".mesura-code-channel-lab"), 3793],
        );
      }),
    );

    it.effect("starts a packaged stable desktop with every identity it has today", () =>
      Effect.gen(function* () {
        for (const packagedField of [undefined, "stable"] as const) {
          const fixture = yield* makePackagedFixture(packagedField);
          yield* Effect.gen(function* () {
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const path = yield* Path.Path;
            const settings = yield* DesktopAppSettings.make;

            assert.deepStrictEqual(
              {
                profile: yield* resolveUserDataPath(environment),
                home: environment.baseDir,
                stateDir: environment.stateDir,
                desktopEntry: environment.linuxDesktopEntryName,
                windowClass: environment.linuxWmClass,
                displayName: environment.displayName,
                backendPort: environment.configuredBackendPort,
                tailscalePort: (yield* settings.load).tailscaleServePort,
              },
              {
                profile: path.join(fixture.homeDirectory, ".config", "mesura-code"),
                home: path.join(fixture.homeDirectory, ".mesura-code"),
                stateDir: path.join(fixture.homeDirectory, ".mesura-code", "userdata"),
                desktopEntry: "mesura-code.desktop",
                windowClass: "mesura-code",
                displayName: "Mesura Code (Beta)",
                // Stable keeps scanning upward from 3773 instead of pinning a port.
                backendPort: Option.none(),
                tailscalePort: 443,
              },
            );
          }).pipe(Effect.provide(packagedEnvironment(fixture)));
        }
      }),
    );

    it.effect("keeps the Lab Tailscale port when a requested port is invalid", () =>
      Effect.gen(function* () {
        const fixture = yield* makePackagedFixture("lab");
        yield* Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(environment.stateDir, { recursive: true });
          const settings = yield* DesktopAppSettings.make;
          yield* settings.load;
          const change = yield* settings.setTailscaleServe({
            enabled: true,
            port: Option.some(0),
          });
          assert.equal(change.settings.tailscaleServePort, 8793);
        }).pipe(Effect.provide(packagedEnvironment(fixture)));
      }),
    );

    it.effect("refuses a packaged manifest it cannot read as a JSON object", () =>
      Effect.gen(function* () {
        const { resolveMesuraChannel } = yield* Effect.promise(() => import("./mesuraChannel.ts"));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "mesura-bad-manifest-" });

        const unreadable = path.join(root, "unreadable");
        yield* fs.makeDirectory(path.join(unreadable, "package.json"), { recursive: true });
        const manifests = {
          invalidJson: "{",
          nullManifest: "null",
          unknown: '{"mesuraChannel":"canary"}',
        };
        const appPaths = [unreadable];
        for (const [name, contents] of Object.entries(manifests)) {
          const appPath = path.join(root, name);
          yield* fs.makeDirectory(appPath);
          yield* fs.writeFileString(path.join(appPath, "package.json"), contents);
          appPaths.push(appPath);
        }

        for (const appPath of appPaths) {
          assert.throws(() => resolveMesuraChannel({ isPackaged: true, appPath }));
        }
        assert.equal(
          resolveMesuraChannel({ isPackaged: true, appPath: path.join(root, "absent") }).channel,
          "stable",
        );
      }),
    );

    it.effect("reads the packaged channel once per app path", () =>
      Effect.gen(function* () {
        const { resolveMesuraChannel } = yield* Effect.promise(() => import("./mesuraChannel.ts"));
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixture = yield* makePackagedFixture("lab");
        assert.equal(resolveMesuraChannel(fixture).channel, "lab");
        yield* fs.writeFileString(
          path.join(fixture.appPath, "package.json"),
          JSON.stringify({ mesuraChannel: "dev" }),
        );
        assert.equal(resolveMesuraChannel(fixture).channel, "lab");
      }),
    );
  },
);

it.each(["own", "inherited"] as const)(
  "desktop channels regression: a Lab app gets its %s setAsDefaultProtocolClient back when the bridge throws",
  (shape) => {
    const original = (_protocol: string) => true;
    class FakeApp {
      setAsDefaultProtocolClient(protocol: string) {
        return original(protocol);
      }
    }
    const app = new FakeApp();
    if (shape === "own") app.setAsDefaultProtocolClient = original;
    const before = app.setAsDefaultProtocolClient;
    let claimedDuringRegister: boolean | undefined;

    assert.throws(
      () =>
        withSharedUrlSchemeOwnership(
          { isDevelopment: false, mesuraChannel: MESURA_DESKTOP_CHANNEL_IDENTITY.lab },
          app,
          () => {
            claimedDuringRegister = app.setAsDefaultProtocolClient("t3code");
            throw new Error("bridge failed");
          },
        ),
      "bridge failed",
    );
    assert.isFalse(claimedDuringRegister);
    assert.strictEqual(app.setAsDefaultProtocolClient, before);
    assert.equal(Object.hasOwn(app, "setAsDefaultProtocolClient"), shape === "own");
  },
);
