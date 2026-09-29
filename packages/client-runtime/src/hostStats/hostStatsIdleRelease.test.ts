/**
 * Phase 6: whether releasing a `hostStats` subscription closes its stream.
 * Mobile keeps its sessions up in the background, so the Hosts screen can only
 * release a stream by dropping its last reader with a zero idle TTL, the value
 * `apps/mobile/src/state/server.ts` passes as `hostStatsIdleTtlMs`. Web keeps
 * the default five minutes so a re-peek of the dock is instant.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  mountEnvironmentSubscription,
  type MountedEnvironmentSubscription,
} from "./environmentSubscriptionHarness.ts";

const mounted: MountedEnvironmentSubscription<unknown, unknown>[] = [];
afterEach(() => {
  for (const subscription of mounted.splice(0)) subscription.dispose();
});

async function mountCountingStream(idleTtlMs: number | undefined) {
  const stream = { open: 0, closed: 0 };
  const subscription = await mountEnvironmentSubscription(
    (messages: Stream.Stream<number>) =>
      Stream.unwrap(
        Effect.sync(() => {
          stream.open += 1;
          return messages.pipe(Stream.ensuring(Effect.sync(() => (stream.closed += 1))));
        }),
      ),
    idleTtlMs === undefined ? {} : { idleTtlMs },
  );
  mounted.push(subscription as MountedEnvironmentSubscription<unknown, unknown>);
  await subscription.offerBurst([1]);
  return { subscription, stream };
}

describe("host stats stream release", () => {
  it("host stats stream with a zero idle TTL closes as soon as its last reader lets go", async () => {
    const { subscription, stream } = await mountCountingStream(0);
    expect(stream).toEqual({ open: 1, closed: 0 });

    await subscription.release();

    expect(stream).toEqual({ open: 1, closed: 1 });
  });

  it("host stats stream with the default idle TTL stays open after its last reader lets go", async () => {
    const { subscription, stream } = await mountCountingStream(undefined);

    await subscription.release();

    expect(stream).toEqual({ open: 1, closed: 0 });
  });
});
