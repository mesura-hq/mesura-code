/**
 * Guard for what the host stats atom can rely on from the shared subscription
 * factory (`createEnvironmentSubscriptionAtomFamily` in `../state/runtime.ts`),
 * mounted through `environmentSubscriptionHarness.ts`. The factory holds only
 * the latest value: messages that land one at a time each reach a listener,
 * and a burst in one chunk reaches it as its last message only. That second
 * fact is why the host stats history is folded inside the stream, not in an
 * atom fed from the subscription.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Stream from "effect/Stream";

import {
  mountEnvironmentSubscription,
  type MountedEnvironmentSubscription,
} from "./environmentSubscriptionHarness.ts";

const mounted: MountedEnvironmentSubscription<unknown, unknown>[] = [];
afterEach(() => {
  for (const subscription of mounted.splice(0)) subscription.dispose();
});

async function mountIdentity() {
  const subscription = await mountEnvironmentSubscription((messages: Stream.Stream<number>) =>
    messages.pipe(Stream.map((message) => message)),
  );
  mounted.push(subscription as MountedEnvironmentSubscription<unknown, unknown>);
  return subscription;
}

describe("host stats subscription delivery guard", () => {
  it("environment subscription atom hands a listener each message that lands alone, in order", async () => {
    const subscription = await mountIdentity();
    for (const message of [1, 2, 3]) await subscription.offerBurst([message]);
    expect(subscription.seen).toEqual([1, 2, 3]);
    expect(subscription.current()).toBe(3);
  });

  it("environment subscription atom hands a listener only the last message of a burst", async () => {
    const subscription = await mountIdentity();
    await subscription.offerBurst([1, 2, 3]);
    expect(subscription.seen).toEqual([3]);
  });
});
