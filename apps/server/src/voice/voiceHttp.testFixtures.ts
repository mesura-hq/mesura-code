/**
 * Shared test doubles for the voice HTTP routes. The authentication middleware double resolves
 * each bearer token to the principal the real middleware would produce after verifying it.
 */
import {
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

export const makeVoiceTestAuthLayer = (
  principalForToken: (token: string) => EnvironmentSessionPrincipalShape,
) =>
  Layer.succeed(EnvironmentAuthenticatedAuth, ((httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      return yield* httpEffect.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principalForToken(token)),
      );
    })) as EnvironmentAuthenticatedAuth["Service"]);
