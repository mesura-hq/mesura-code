/**
 * Phone push contract: `PushSubscriptionInput` decodes every `push.subscribe` request, and
 * `clientRpcRequiredScopes` is what `createEnvironmentRpcCommand` checks before a guarded RPC.
 */
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AuthSettingsWriteScope } from "./auth.ts";
import { CLIENT_GUARDED_RPC_SCOPES, clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { PushSubscriptionInput } from "./pushNotifications.ts";
import { WS_METHODS } from "./rpc.ts";

const PUSH_METHODS = [
  ["pushPublicKey", "push.publicKey"],
  ["pushSubscribe", "push.subscribe"],
  ["pushUnsubscribe", "push.unsubscribe"],
  ["pushStatus", "push.status"],
  ["pushSendTest", "push.sendTest"],
] as const;

const decodeSubscription = Schema.decodeUnknownExit(PushSubscriptionInput);

// A real `PushSubscription.toJSON()` shape from Chrome on Android.
const chromeSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/dXq3b9:APA91bH-test",
  keys: {
    p256dh:
      "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
    auth: "tBHItJI5svbpez7KI4CCXg",
  },
  label: "Chrome on Android",
};

describe("push notifications phase 1 fence: contract", () => {
  it("push phase 1 contract: the push RPCs carry the names the plan lists", () => {
    for (const [key, name] of PUSH_METHODS) {
      expect((WS_METHODS as Record<string, string>)[key], key).toBe(name);
    }
  });

  it("push phase 1 contract: a subscription without preferences gets approval, input and failed on, completed off", () => {
    const decoded = decodeSubscription(chromeSubscription);
    expect(Exit.isSuccess(decoded)).toBe(true);
    if (!Exit.isSuccess(decoded)) return;
    expect(decoded.value.endpoint).toBe(chromeSubscription.endpoint);
    expect(decoded.value.keys).toEqual(chromeSubscription.keys);
    expect(decoded.value.label).toBe("Chrome on Android");
    expect(decoded.value.preferences).toEqual({
      approval: true,
      input: true,
      failed: true,
      completed: false,
    });
  });

  it("push phase 1 contract: a subscription keeps the preferences the device sent", () => {
    const preferences = { approval: false, input: true, failed: false, completed: true };
    const decoded = decodeSubscription({ ...chromeSubscription, preferences });
    expect(Exit.isSuccess(decoded) && decoded.value.preferences).toEqual(preferences);
  });

  it("push phase 1 contract: a subscription with a non-https endpoint or non-base64url keys is refused", () => {
    for (const invalid of [
      { ...chromeSubscription, endpoint: "http://fcm.googleapis.com/fcm/send/x" },
      { ...chromeSubscription, endpoint: "not a url" },
      { ...chromeSubscription, keys: { ...chromeSubscription.keys, p256dh: "a+b/c=" } },
      { ...chromeSubscription, keys: { ...chromeSubscription.keys, auth: "" } },
    ]) {
      expect(Exit.isFailure(decodeSubscription(invalid)), JSON.stringify(invalid)).toBe(true);
    }
  });
});

describe("push notifications phase 1 fence: client scope (AC6)", () => {
  it("push phase 1 AC6: every push RPC is a client-guarded RPC that needs settings:write", () => {
    for (const [, name] of PUSH_METHODS) {
      expect((CLIENT_GUARDED_RPC_SCOPES as Record<string, string>)[name], name).toBe(
        AuthSettingsWriteScope,
      );
      expect(clientRpcRequiredScopes(name, undefined), name).toEqual([AuthSettingsWriteScope]);
    }
  });
});
