import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAttachmentUploadRequest } from "./attachmentUploadHttp.ts";

it.effect("creates a fresh DPoP proof for every resumable upload request", () =>
  Effect.gen(function* () {
    const proofInputs: ManagedRelay.ManagedRelayDpopProofInput[] = [];
    const signer = ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("thumbprint"),
      createProof: (input) => {
        proofInputs.push(input);
        return Effect.succeed(`proof-${proofInputs.length}`);
      },
    });
    const prepared = {
      environmentId: "environment-1",
      label: "Remote environment",
      httpBaseUrl: "https://environment.example.test",
      socketUrl: "wss://environment.example.test/ws",
      httpAuthorization: { _tag: "Dpop", accessToken: "access-token" },
      target: { _tag: "RelayConnectionTarget", environmentId: "environment-1", label: "Remote" },
    } as PreparedConnection;
    const observed: Array<{
      readonly method: string;
      readonly authorization: string | null;
      readonly dpop: string | null;
    }> = [];
    const fetch = (request: Request) => {
      observed.push({
        method: request.method,
        authorization: request.headers.get("authorization"),
        dpop: request.headers.get("dpop"),
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    for (const method of ["POST", "HEAD", "PATCH", "DELETE"] as const) {
      yield* executeAttachmentUploadRequest({
        prepared,
        signer: Option.some(signer),
        fetch,
        method,
        uploadPath: `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/upload-id`,
        headers: { "Tus-Resumable": "1.0.0" },
      });
    }

    expect(proofInputs.map((input) => input.method)).toEqual(["POST", "HEAD", "PATCH", "DELETE"]);
    expect(observed.map((request) => request.authorization)).toEqual([
      "DPoP access-token",
      "DPoP access-token",
      "DPoP access-token",
      "DPoP access-token",
    ]);
    expect(observed.map((request) => request.dpop)).toEqual([
      "proof-1",
      "proof-2",
      "proof-3",
      "proof-4",
    ]);
  }),
);

it.effect("rejects upload URLs outside the prepared environment before adding credentials", () =>
  Effect.gen(function* () {
    let proofCount = 0;
    const signer = ManagedRelay.ManagedRelayDpopSigner.of({
      thumbprint: Effect.succeed("thumbprint"),
      createProof: () => {
        proofCount += 1;
        return Effect.succeed("proof");
      },
    });
    const prepared = {
      environmentId: "environment-1",
      label: "Remote environment",
      httpBaseUrl: "https://environment.example.test",
      socketUrl: "wss://environment.example.test/ws",
      httpAuthorization: { _tag: "Dpop", accessToken: "access-token" },
      target: { _tag: "RelayConnectionTarget", environmentId: "environment-1", label: "Remote" },
    } as PreparedConnection;

    const result = yield* executeAttachmentUploadRequest({
      prepared,
      signer: Option.some(signer),
      method: "POST",
      uploadPath: "https://attacker.example.test/collect",
    }).pipe(Effect.result);

    expect(result._tag).toBe("Failure");
    expect(proofCount).toBe(0);
  }),
);
