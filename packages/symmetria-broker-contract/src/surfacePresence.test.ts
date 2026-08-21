import { ClientActivityLease, ClientKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { expectGoldenRoundTrip, readGoldenFixture } from "../test/goldenFixture.ts";
import {
  SYMMETRIA_SURFACE_KINDS,
  SYMMETRIA_SURFACE_PRESENCE_EXCLUDED_UPSTREAM_FIELDS,
  SymmetriaSurfacePresence,
  symmetriaSurfacePresenceFromLease,
} from "./surfacePresence.ts";

const GOLDEN = "surfacePresence.golden.json";

const decode = Schema.decodeUnknownResult(SymmetriaSurfacePresence);
const decodeOrThrow = Schema.decodeUnknownSync(SymmetriaSurfacePresence);
const encodeOrThrow = Schema.encodeSync(SymmetriaSurfacePresence);

const lease = Schema.decodeUnknownSync(ClientActivityLease)({
  sessionId: "aus_2f10c9",
  rpcClientId: 41,
  clientId: "clt_desktop_7a1e",
  clientKind: "desktop-renderer",
  visible: true,
  focused: true,
  recentlyInteracted: false,
  lowPowerMode: "false",
  batteryState: "charging",
  networkType: "wifi",
  scopes: [
    { type: "thread", threadId: "thr_9f3c1a7e" },
    { type: "vcs-status", cwd: "/home/dev/worktrees/symmetria-broker-contract" },
    { type: "thread", threadId: "thr_2c88be40" },
    { type: "server-config" },
  ],
  // `ClientActivityLease` timestamps are `Schema.DateTimeUtc`, whose encoded
  // form is a `DateTime.Utc` and not a string — that difference is exactly why
  // the Symmetria projection carries `IsoDateTime` instead.
  updatedAt: DateTime.makeUnsafe("2026-08-20T09:14:03.120Z"),
  expiresAt: DateTime.makeUnsafe("2026-08-20T09:15:03.120Z"),
});

describe("SymmetriaSurfacePresence", () => {
  it("round-trips the golden fixture byte-identically", () => {
    expectGoldenRoundTrip(SymmetriaSurfacePresence, GOLDEN);
  });

  it("decodes every surface kind it knows unchanged", () => {
    const golden = readGoldenFixture(GOLDEN);
    for (const kind of SYMMETRIA_SURFACE_KINDS) {
      expect(decodeOrThrow({ ...golden, surfaceKind: kind }).surfaceKind).toBe(kind);
    }
  });

  it("decodes a surface kind the fork does not know as unknown", () => {
    const golden = readGoldenFixture(GOLDEN);
    for (const kind of ["future-surface-kind", "watch", ""]) {
      expect(decodeOrThrow({ ...golden, surfaceKind: kind }).surfaceKind).toBe("unknown");
    }
  });

  it("still refuses a surface kind that is not a string at all", () => {
    const golden = readGoldenFixture(GOLDEN);
    expect(Result.isFailure(decode({ ...golden, surfaceKind: 7 }))).toBe(true);
    expect(Result.isFailure(decode({ ...golden, surfaceKind: null }))).toBe(true);
  });

  it("keeps every upstream client kind expressible", () => {
    const kinds: ReadonlyArray<ClientKind> = ClientKind.literals;
    for (const kind of kinds) {
      expect(SYMMETRIA_SURFACE_KINDS).toContain(kind);
    }
  });

  it("projects a lease into presence, taking thread ids from its scopes", () => {
    const presence = symmetriaSurfacePresenceFromLease(lease);
    expect(presence.threadIds).toEqual(["thr_9f3c1a7e", "thr_2c88be40"]);
    expect(presence.surfaceKind).toBe("desktop-renderer");
    expect(presence.updatedAt).toBe("2026-08-20T09:14:03.120Z");
    expect(presence.expiresAt).toBe("2026-08-20T09:15:03.120Z");
    expect(Result.isSuccess(decode(encodeOrThrow(presence)))).toBe(true);
  });

  it("leaves every excluded lease field out of the projection", () => {
    const presence: Record<string, unknown> = symmetriaSurfacePresenceFromLease(lease);
    for (const field of SYMMETRIA_SURFACE_PRESENCE_EXCLUDED_UPSTREAM_FIELDS) {
      expect(Object.hasOwn(presence, field), `${field} crossed the allowlist`).toBe(false);
    }
  });

  it("drops every excluded lease field handed straight to the decoder", () => {
    const golden = readGoldenFixture(GOLDEN);
    // Built from the list rather than from a handful of names, so a field
    // nobody remembered to inject cannot pass its assertion vacuously. `scopes`
    // is the one that matters most: it is the only excluded field carrying a
    // host filesystem path (`BackgroundScope`, background.ts:53).
    const injected = Object.fromEntries(
      SYMMETRIA_SURFACE_PRESENCE_EXCLUDED_UPSTREAM_FIELDS.map((field) => [
        field,
        field === "scopes"
          ? [{ type: "vcs-status", cwd: "/home/dev/worktrees/symmetria-broker-contract" }]
          : `leaked-${field}`,
      ]),
    );
    const payload = { ...golden, ...injected };
    for (const field of SYMMETRIA_SURFACE_PRESENCE_EXCLUDED_UPSTREAM_FIELDS) {
      expect(Object.hasOwn(payload, field), `${field} was never injected`).toBe(true);
    }

    const decoded: Record<string, unknown> = decodeOrThrow(payload);
    for (const field of SYMMETRIA_SURFACE_PRESENCE_EXCLUDED_UPSTREAM_FIELDS) {
      expect(Object.hasOwn(decoded, field), `${field} crossed the allowlist`).toBe(false);
    }
  });
});
