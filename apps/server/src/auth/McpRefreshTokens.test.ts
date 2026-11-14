/**
 * Mesura: the refresh grant. Entry point: the MCP OAuth routes served with
 * `HttpRouter.serve` inside `it.effect`, so `TestClock` drives lifetimes; `/mcp`
 * acceptance is `EnvironmentAuth.authenticateMcpClient`, as in production.
 */
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AuthMcpClientAccess,
  AuthMcpRegisteredClient,
  EnvironmentHttpApi,
  MCP_PEER_LINK_SOFTWARE_ID,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
import * as McpOAuth from "./McpOAuth.ts";
import * as McpOAuthHttp from "./mcpOAuthHttp.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

class RefreshTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.mcpOAuth) {}

const REDIRECT = "http://localhost/callback";
const CALLBACK = "http://localhost:51234/callback";
const verifier = "a".repeat(43) + "-verifier-for-tests";
const challenge = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";
const RETRY_WINDOW = Duration.seconds(60);
const ACCESS_TOKEN_TTL = Duration.days(30);

interface TokenBody {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly token_type?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly error?: string;
}

interface TokenReply {
  readonly status: number;
  readonly body: TokenBody;
}

/** The MCP OAuth routes on a socket, with this environment's auth and database. */
const serveOAuth = Effect.gen(function* () {
  const context = yield* EnvironmentAuth.layer.pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-refresh-test-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.fresh,
    Layer.build,
  );
  const layerRoutes = HttpApiBuilder.layer(RefreshTestApi).pipe(
    Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.succeedContext(context)),
  );
  yield* HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  );
  const address = (yield* HttpServer.HttpServer).address;
  if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
  const sql = Context.get(context, SqlClient.SqlClient);
  const crypto = Context.get(context, Crypto.Crypto);
  const sha256 = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.orDie,
      Effect.map((digest) => Buffer.from(digest)),
    );

  const client = yield* HttpClient.HttpClient;
  const execute = (request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(Effect.orDie);
  const send = (path: string) => execute(HttpClientRequest.get(path));
  const sendJson = (path: string, body: unknown) =>
    execute(HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body)));
  const readJson = <A>(response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.orDie,
      Effect.map((body) => body as A),
    );

  const register = (
    options: {
      readonly peerLink?: boolean;
      readonly clientName?: string;
      readonly grantTypes?: ReadonlyArray<string>;
    } = {},
  ) =>
    sendJson("/oauth/mcp/register", {
      client_name: options.clientName ?? (options.peerLink ? "Mesura Code · Laptop" : "Atlas"),
      redirect_uris: [REDIRECT],
      ...(options.grantTypes === undefined
        ? { grant_types: ["authorization_code", "refresh_token"] }
        : options.grantTypes.length === 0
          ? {}
          : { grant_types: options.grantTypes }),
      token_endpoint_auth_method: "none",
      ...(options.peerLink ? { software_id: MCP_PEER_LINK_SOFTWARE_ID } : {}),
    });

  const token = (fields: Record<string, string>) =>
    execute(
      HttpClientRequest.post("/oauth/mcp/token").pipe(HttpClientRequest.bodyUrlParams(fields)),
    ).pipe(
      Effect.flatMap((response) =>
        readJson<TokenBody>(response).pipe(
          Effect.map((body): TokenReply => ({ status: response.status, body })),
        ),
      ),
    );

  /** A pairing-code sign-in up to the authorization code exchange, whatever it answers. */
  const exchangeCode = (
    options: {
      readonly access?: AuthMcpClientAccess;
      readonly peerLink?: boolean;
      readonly clientName?: string;
    } = {},
  ) =>
    Effect.gen(function* () {
      const { client_id: clientId } = yield* register(options).pipe(
        Effect.flatMap(readJson<{ client_id: string }>),
      );
      const authorization = {
        response_type: "code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "state-1",
        resource: `${origin}/mcp`,
      };
      const pairing = yield* auth.issuePairingCredential();
      const approved = yield* sendJson("/oauth/mcp/decision", {
        authorization,
        decision: {
          _tag: "pairing-code",
          access: options.access ?? "auto",
          code: pairing.credential,
        },
      }).pipe(Effect.flatMap(readJson<{ redirectTo?: string }>));
      const code = new URL(approved.redirectTo!).searchParams.get("code")!;
      const exchanged = yield* token({
        grant_type: "authorization_code",
        code,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${origin}/mcp`,
      });
      return { clientId, exchanged };
    });

  /** A pairing-code sign-in that ends at the authorization code exchange. */
  const signIn = (options: Parameters<typeof exchangeCode>[0] = {}) =>
    Effect.gen(function* () {
      const { clientId, exchanged } = yield* exchangeCode(options);
      expect(exchanged.status).toBe(200);
      const client = yield* mcpClient(exchanged.body.access_token!);
      return { clientId, sessionId: client.sessionId, tokens: exchanged.body };
    });

  const refresh = (refreshToken: string | undefined, clientId: string) =>
    token({ grant_type: "refresh_token", refresh_token: refreshToken ?? "", client_id: clientId });

  /** What `/mcp` sees for this bearer. */
  const mcpClient = (accessToken: string) =>
    auth.authenticateMcpClient(
      HttpServerRequest.fromWeb(
        new Request(`${origin}/mcp`, { headers: { authorization: `Bearer ${accessToken}` } }),
      ),
    );

  const sessionRow = (sessionId: string) =>
    sql<{ readonly expiresAt: string; readonly revokedAt: string | null }>`
      SELECT expires_at AS "expiresAt", revoked_at AS "revokedAt"
      FROM auth_sessions
      WHERE session_id = ${sessionId}
    `.pipe(Effect.map((rows) => rows[0]!));

  return {
    origin,
    auth,
    sql,
    sha256,
    send,
    readJson,
    register,
    exchangeCode,
    signIn,
    refresh,
    mcpClient,
    sessionRow,
  };
});

const withOAuth = <A, E>(use: (served: Effect.Success<typeof serveOAuth>) => Effect.Effect<A, E>) =>
  Effect.scoped(serveOAuth.pipe(Effect.flatMap(use))).pipe(
    Effect.provide(NodeHttpServer.layerTest),
  );

const expectInvalidGrant = (reply: TokenReply) => {
  expect(reply.status, JSON.stringify(reply.body)).toBe(400);
  expect(reply.body.error).toBe("invalid_grant");
};

const expectRenewed = (reply: TokenReply) => {
  expect(reply.status, JSON.stringify(reply.body)).toBe(200);
  return reply.body;
};

it.effect(
  "refresh grant: the authorization code exchange returns a refresh token and stores only its hash",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        const { tokens } = yield* served.signIn();
        expect(tokens.access_token).toEqual(expect.any(String));
        expect(tokens.refresh_token).toMatch(/^mrt_[A-Za-z0-9_-]{43}$/);
        const refreshToken = tokens.refresh_token!;

        const rows = yield* served.sql<Record<string, unknown>>`
          SELECT * FROM mesura_mcp_refresh_tokens
        `;
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows)).not.toContain(refreshToken);
        expect(JSON.stringify(rows)).not.toContain(refreshToken.slice("mrt_".length));
        const digest = yield* served.sha256(refreshToken);
        expect([digest.toString("hex"), digest.toString("base64url")]).toContain(
          rows[0]!.token_hash,
        );
      }),
    ),
);

it.effect(
  "refresh grant: renewing keeps the session id, runtime ceiling and peer-link mark and rotates the refresh token",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        for (const options of [
          { access: "auto-accept-edits", peerLink: true },
          { access: "full-access", peerLink: false },
        ] as const) {
          const first = yield* served.signIn(options);
          // Same claims at the same instant sign the same bytes.
          yield* TestClock.adjust(Duration.seconds(1));
          const renewed = expectRenewed(
            yield* served.refresh(first.tokens.refresh_token, first.clientId),
          );
          expect(renewed.token_type).toBe("Bearer");
          expect(renewed.scope).toBe(first.tokens.scope);
          expect(renewed.access_token).toEqual(expect.any(String));
          expect(renewed.access_token).not.toBe(first.tokens.access_token);
          expect(renewed.refresh_token).toMatch(/^mrt_[A-Za-z0-9_-]{43}$/);
          expect(renewed.refresh_token).not.toBe(first.tokens.refresh_token);

          const client = yield* served.mcpClient(renewed.access_token!);
          expect(client).toMatchObject({
            sessionId: first.sessionId,
            access: options.access,
            peerLink: options.peerLink,
          });
        }
      }),
    ),
);

it.effect(
  "refresh grant: the renewed access token passes /mcp and pushes the session row's expiry",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        const { clientId, sessionId, tokens } = yield* served.signIn();
        const before = yield* served.sessionRow(sessionId);

        yield* TestClock.adjust(Duration.days(25));
        const renewed = expectRenewed(yield* served.refresh(tokens.refresh_token, clientId));
        expect(renewed.expires_in).toBe(Duration.toSeconds(ACCESS_TOKEN_TTL));
        const after = yield* served.sessionRow(sessionId);
        expect(Date.parse(after.expiresAt) - Date.parse(before.expiresAt)).toBe(
          Duration.toMillis(Duration.days(25)),
        );

        // Past the first token's 30 days, only the renewed one still opens /mcp.
        yield* TestClock.adjust(Duration.days(10));
        expect(yield* served.mcpClient(renewed.access_token!)).toMatchObject({ sessionId });
        const firstToken = yield* served.mcpClient(tokens.access_token!).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        );
        expect(firstToken).toEqual(expect.any(String));
        // The renewed session stays listed in Settings → Connections.
        expect((yield* served.auth.listSessions()).map((session) => session.sessionId)).toContain(
          sessionId,
        );
      }),
    ),
);

it.effect(
  "refresh grant: replaying a spent refresh token past the 60-second window answers invalid_grant and revokes the session",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        const { clientId, sessionId, tokens } = yield* served.signIn();
        const renewed = expectRenewed(yield* served.refresh(tokens.refresh_token, clientId));

        yield* TestClock.adjust(Duration.sum(RETRY_WINDOW, Duration.seconds(1)));
        expectInvalidGrant(yield* served.refresh(tokens.refresh_token, clientId));

        expect((yield* served.sessionRow(sessionId)).revokedAt).not.toBeNull();
        yield* served.mcpClient(renewed.access_token!).pipe(Effect.flip);
        expectInvalidGrant(yield* served.refresh(renewed.refresh_token, clientId));
      }),
    ),
);

it.effect(
  "refresh grant: a retry inside the 60-second window renews again and retires the first successor",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        const { clientId, sessionId, tokens } = yield* served.signIn();
        const lost = expectRenewed(yield* served.refresh(tokens.refresh_token, clientId));

        yield* TestClock.adjust(Duration.seconds(30));
        const retried = expectRenewed(yield* served.refresh(tokens.refresh_token, clientId));
        expect(retried.refresh_token).not.toBe(lost.refresh_token);
        expect((yield* served.sessionRow(sessionId)).revokedAt).toBeNull();
        expect(yield* served.mcpClient(retried.access_token!)).toMatchObject({ sessionId });

        expectInvalidGrant(yield* served.refresh(lost.refresh_token, clientId));
      }),
    ),
);

it.effect(
  "refresh grant: a refresh token of a revoked session, an expired one, or one sent with another client_id answers invalid_grant",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        // Another client's id, valid in itself. Registration is stateless, so identical metadata
        // would sign the same client_id.
        const stolen = yield* served.signIn();
        const other = yield* served.signIn({ clientName: "Another agent" });
        expectInvalidGrant(yield* served.refresh(stolen.tokens.refresh_token, other.clientId));

        // A session revoked in Settings → Connections.
        const revoked = yield* served.signIn();
        const admin = yield* served.auth.issueSession();
        yield* served.auth.revokeClientSession(admin.sessionId, revoked.sessionId);
        expectInvalidGrant(yield* served.refresh(revoked.tokens.refresh_token, revoked.clientId));

        // A refresh token lives 90 days, past the 30 of its access token.
        const offline = yield* served.signIn();
        const expiring = yield* served.signIn();
        yield* TestClock.adjust(Duration.days(89));
        expectRenewed(yield* served.refresh(offline.tokens.refresh_token, offline.clientId));
        yield* TestClock.adjust(Duration.days(2));
        expectInvalidGrant(yield* served.refresh(expiring.tokens.refresh_token, expiring.clientId));
      }),
    ),
);

it.effect(
  "refresh grant: authorization-server metadata and the registration response list the refresh_token grant",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        const metadata = yield* served
          .send("/.well-known/oauth-authorization-server")
          .pipe(Effect.flatMap(served.readJson<{ grant_types_supported: ReadonlyArray<string> }>));
        expect(metadata.grant_types_supported).toEqual(
          expect.arrayContaining(["authorization_code", "refresh_token"]),
        );

        const registered = yield* served
          .register()
          .pipe(Effect.flatMap(served.readJson<{ grant_types: ReadonlyArray<string> }>));
        expect(registered.grant_types).toEqual(
          expect.arrayContaining(["authorization_code", "refresh_token"]),
        );
      }),
    ),
);

it.effect("refresh grant guard: a client that never renews keeps a 30-day access token", () =>
  withOAuth((served) =>
    Effect.gen(function* () {
      const { sessionId, tokens } = yield* served.signIn();
      expect(tokens.expires_in).toBe(Duration.toSeconds(ACCESS_TOKEN_TTL));

      yield* TestClock.adjust(Duration.subtract(ACCESS_TOKEN_TTL, Duration.seconds(1)));
      expect(yield* served.mcpClient(tokens.access_token!)).toMatchObject({ sessionId });

      yield* TestClock.adjust(Duration.seconds(2));
      yield* served.mcpClient(tokens.access_token!).pipe(Effect.flip);
    }),
  ),
);

it.effect("refresh grant guard: revoking an MCP client in Connections closes /mcp at once", () =>
  withOAuth((served) =>
    Effect.gen(function* () {
      const { sessionId, tokens } = yield* served.signIn();
      const admin = yield* served.auth.issueSession();
      expect(yield* served.auth.revokeClientSession(admin.sessionId, sessionId)).toBe(true);
      yield* served.mcpClient(tokens.access_token!).pipe(Effect.flip);
      expect((yield* served.sessionRow(sessionId)).revokedAt).not.toBeNull();
    }),
  ),
);

// The result schema as released before the refresh grant, which peers still run.
const decodeReleasedTokenResult = Schema.decodeUnknownSync(
  Schema.Struct({
    access_token: Schema.String,
    token_type: Schema.Literal("Bearer"),
    expires_in: Schema.Number,
    scope: Schema.String,
  }),
);

it("refresh grant guard: a peer decoding token results with the old schema ignores refresh_token", () => {
  const decoded = decodeReleasedTokenResult({
    access_token: "access",
    token_type: "Bearer",
    expires_in: 2_592_000,
    scope: "orchestration:read",
    refresh_token: `mrt_${"x".repeat(43)}`,
  });
  expect(decoded).toEqual({
    access_token: "access",
    token_type: "Bearer",
    expires_in: 2_592_000,
    scope: "orchestration:read",
  });
});

it.effect(
  "refresh grant regression: a retry inside the window after the successor already rotated renews and retires the whole chain",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        const { clientId, sessionId, tokens } = yield* served.signIn();
        const b = expectRenewed(yield* served.refresh(tokens.refresh_token, clientId));
        yield* TestClock.adjust(Duration.seconds(10));
        const c = expectRenewed(yield* served.refresh(b.refresh_token, clientId));

        yield* TestClock.adjust(Duration.seconds(20));
        const retried = expectRenewed(yield* served.refresh(tokens.refresh_token, clientId));
        expect((yield* served.sessionRow(sessionId)).revokedAt).toBeNull();
        expect(yield* served.mcpClient(retried.access_token!)).toMatchObject({ sessionId });

        // One usable chain: what B and C produced is gone, without revoking the session.
        expectInvalidGrant(yield* served.refresh(b.refresh_token, clientId));
        expectInvalidGrant(yield* served.refresh(c.refresh_token, clientId));
        expect((yield* served.sessionRow(sessionId)).revokedAt).toBeNull();
        expectRenewed(yield* served.refresh(retried.refresh_token, clientId));
      }),
    ),
);

it.effect(
  "refresh grant regression: when the refresh token cannot be stored, the code exchange fails and revokes the new session",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        yield* served.sql`DROP TABLE mesura_mcp_refresh_tokens`;
        const { exchanged } = yield* served.exchangeCode();
        expectInvalidGrant(exchanged);
        expect(exchanged.body.access_token).toBeUndefined();

        const sessions = yield* served.sql<{ readonly revokedAt: string | null }>`
          SELECT revoked_at AS "revokedAt" FROM auth_sessions WHERE subject = 'mcp-client'
        `;
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.revokedAt).not.toBeNull();
      }),
    ),
);

// The registration response schema as released before the refresh grant, which peers still run.
const decodeReleasedRegisteredClient = Schema.decodeUnknownSync(
  Schema.Struct({
    client_id: Schema.String,
    client_name: Schema.String,
    redirect_uris: Schema.Array(Schema.String),
    grant_types: Schema.Array(Schema.Literal("authorization_code")),
    response_types: Schema.Array(Schema.Literal("code")),
    token_endpoint_auth_method: Schema.Literal("none"),
  }),
);

it.effect(
  "refresh grant regression: a peer on a release before the refresh grant decodes this server's registration response",
  () =>
    withOAuth((served) =>
      Effect.gen(function* () {
        // What PeerLinks.signIn sends in those releases: no grant_types.
        const response = yield* served.register({ peerLink: true, grantTypes: [] });
        expect(response.status).toBe(201);
        const decoded = decodeReleasedRegisteredClient(yield* served.readJson<unknown>(response));
        expect(decoded.grant_types).toEqual(["authorization_code"]);
      }),
    ),
);

const decodeRegisteredClient = Schema.decodeUnknownSync(AuthMcpRegisteredClient);

it("refresh grant regression: this release decodes the registration response of a server before the refresh grant", () => {
  const decoded = decodeRegisteredClient({
    client_id: "client",
    client_name: "Mesura Code · Laptop",
    redirect_uris: ["http://localhost/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  expect(decoded.grant_types).toEqual(["authorization_code"]);
});
