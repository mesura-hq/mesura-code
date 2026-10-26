/**
 * A push service and a subscribed browser, played by the test process. The receiver follows
 * RFC 8291 (over RFC 8188 `aes128gcm`) and RFC 8292 (VAPID), not `web-push`, so a spec that
 * decrypts with it does not trust the library under test. Subscriptions keep a real `https://`
 * endpoint; the returned `httpClient` layer routes every request to the loopback server.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no ECDH, HMAC or AES-GCM, which the receiver needs.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the fake push service is a raw HTTP server that records bodies byte for byte.
import * as NodeHttp from "node:http";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const fromBase64url = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

/** What a browser's `PushSubscription.toJSON()` gives the app, plus its private half. */
export interface FakeBrowserSubscription {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly decrypt: (body: Uint8Array) => Uint8Array;
}

export const makeBrowserSubscription = (endpoint: string): FakeBrowserSubscription => {
  const ecdh = NodeCrypto.createECDH("prime256v1");
  const userAgentPublic = new Uint8Array(ecdh.generateKeys());
  const authSecret = new Uint8Array(NodeCrypto.randomBytes(16));
  return {
    endpoint,
    keys: { p256dh: base64url(userAgentPublic), auth: base64url(authSecret) },
    decrypt: (body) =>
      decryptAes128gcm(body, {
        sharedSecret: (senderPublic) => new Uint8Array(ecdh.computeSecret(senderPublic)),
        userAgentPublic,
        authSecret,
      }),
  };
};

const hmac = (key: Uint8Array, ...data: ReadonlyArray<Uint8Array>) => {
  const mac = NodeCrypto.createHmac("sha256", key);
  for (const part of data) mac.update(part);
  return new Uint8Array(mac.digest());
};
const text = (value: string) => new TextEncoder().encode(value);
const ONE = new Uint8Array([1]);
const ZERO = new Uint8Array([0]);

/** RFC 8291 section 3.4 and RFC 8188 section 2, for a body of one record. */
function decryptAes128gcm(
  body: Uint8Array,
  receiver: {
    readonly sharedSecret: (senderPublic: Uint8Array) => Uint8Array;
    readonly userAgentPublic: Uint8Array;
    readonly authSecret: Uint8Array;
  },
): Uint8Array {
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const keyIdLength = body[20]!;
  const senderPublic = body.subarray(21, 21 + keyIdLength);
  const record = body.subarray(21 + keyIdLength);
  if (keyIdLength !== 65) throw new Error(`keyid is ${keyIdLength} bytes, not a P-256 point`);
  if (record.length > recordSize) throw new Error("body holds more than one record");

  const ecdhSecret = receiver.sharedSecret(senderPublic);
  const prkKey = hmac(receiver.authSecret, ecdhSecret);
  const keyInfo = new Uint8Array([
    ...text("WebPush: info"),
    0,
    ...receiver.userAgentPublic,
    ...senderPublic,
  ]);
  const ikm = hmac(prkKey, keyInfo, ONE);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, text("Content-Encoding: aes128gcm"), ZERO, ONE).subarray(0, 16);
  const nonce = hmac(prk, text("Content-Encoding: nonce"), ZERO, ONE).subarray(0, 12);

  const decipher = NodeCrypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = new Uint8Array([
    ...decipher.update(record.subarray(0, record.length - 16)),
    ...decipher.final(),
  ]);
  // The last record ends with the delimiter 0x02, then zero padding.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end -= 1;
  if (padded[end] !== 2) throw new Error("the record has no last-record delimiter");
  return padded.subarray(0, end);
}

export interface VapidAuthorization {
  readonly publicKey: string;
  readonly header: { readonly typ?: string; readonly alg?: string };
  readonly claims: { readonly aud?: string; readonly exp?: number; readonly sub?: string };
  readonly signatureValid: boolean;
}

/** Parses `vapid t=…, k=…` and checks the JWT's ES256 signature against `k`. */
export function readVapidAuthorization(header: string | undefined): VapidAuthorization {
  const match = /^vapid t=([^,\s]+),\s*k=([^,\s]+)$/.exec(header ?? "");
  if (match === null) throw new Error(`not a VAPID Authorization header: ${header}`);
  const [, token, publicKey] = match as unknown as [string, string, string];
  const [encodedHeader, encodedClaims, encodedSignature] = token.split(".") as [
    string,
    string,
    string,
  ];
  const point = fromBase64url(publicKey);
  const key = NodeCrypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: base64url(point.subarray(1, 33)),
      y: base64url(point.subarray(33, 65)),
    },
    format: "jwk",
  });
  const signatureValid = NodeCrypto.verify(
    "sha256",
    text(`${encodedHeader}.${encodedClaims}`),
    { key, dsaEncoding: "ieee-p1363" },
    fromBase64url(encodedSignature),
  );
  return {
    publicKey,
    header: JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")),
    signatureValid,
  };
}

export interface CapturedPush {
  readonly method: string;
  /** The path and query of the subscription endpoint the request was for. */
  readonly path: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Uint8Array;
}

/** A status, or a status with response headers (a redirect's `location`). */
export type FakePushAnswer =
  | number
  | { readonly status: number; readonly headers: Readonly<Record<string, string>> };

/**
 * A push service on 127.0.0.1 that records every request and answers with
 * `answer(path)`, 201 by default, as FCM does for an accepted message.
 */
export const fakePushService = Effect.fn("fakePushService")(function* (
  answer: (path: string) => FakePushAnswer = () => 201,
) {
  const requests: Array<CapturedPush> = [];
  const { origin } = yield* Effect.acquireRelease(
    Effect.callback<{ readonly origin: string; readonly server: NodeHttp.Server }>((resume) => {
      const server = NodeHttp.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const path = request.url ?? "/";
          requests.push({
            method: request.method ?? "",
            path,
            headers: request.headers,
            body: new Uint8Array(Buffer.concat(chunks)),
          });
          const reply = answer(path);
          if (typeof reply === "number") {
            response.statusCode = reply;
          } else {
            response.statusCode = reply.status;
            for (const [name, value] of Object.entries(reply.headers)) {
              response.setHeader(name, value);
            }
          }
          response.end();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("no TCP address");
        resume(Effect.succeed({ origin: `http://127.0.0.1:${address.port}`, server }));
      });
    }),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  return {
    requests,
    /** An HttpClient that delivers every request to this push service, keeping its path. */
    httpClient: Layer.effect(
      HttpClient.HttpClient,
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return HttpClient.mapRequest(client, (request) => {
          const url = new URL(request.url);
          return HttpClientRequest.setUrl(request, `${origin}${url.pathname}${url.search}`);
        });
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer)),
  };
});
