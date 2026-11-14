/**
 * Mesura: the MCP OAuth refresh grant. Opaque tokens, stored only as SHA-256 hashes, rotate on
 * every use; a spent token replayed past the retry window revokes the session (RFC 9700). Renewal
 * keeps the session id. The design is in `docs/internals/environment-auth.md`.
 */
import { AuthMcpClientAccess, type AuthSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "./SessionStore.ts";
import { base64UrlEncode } from "./utils.ts";

/** The lifetime of an MCP client's access token, issued or renewed. */
export const MCP_CLIENT_SESSION_TTL = Duration.days(30);
/** Sliding: every rotation issues a token with a fresh lifetime. */
const MCP_REFRESH_TOKEN_TTL = Duration.days(90);
const MCP_REFRESH_RETRY_WINDOW = Duration.seconds(60);

const TOKEN_PREFIX = "mrt_";
const TOKEN_PATTERN = /^mrt_[A-Za-z0-9_-]{43}$/;

/** What a refresh token restores on renewal. */
export interface McpRefreshGrant {
  readonly sessionId: AuthSessionId;
  readonly access: AuthMcpClientAccess;
  readonly peerLink: boolean;
}

export interface McpRenewedSession extends McpRefreshGrant {
  readonly token: string;
  readonly expiresAt: DateTime.DateTime;
  readonly refreshToken: string;
}

export class McpRefreshTokenRejectedError extends Schema.TaggedError<McpRefreshTokenRejectedError>()(
  "McpRefreshTokenRejectedError",
  {
    reason: Schema.Literals(["unknown", "other-client", "session-revoked", "expired", "replayed"]),
  },
) {
  override get message(): string {
    return `The refresh token was rejected (${this.reason}).`;
  }
}

export class McpRefreshTokenStoreError extends Schema.TaggedError<McpRefreshTokenStoreError>()(
  "McpRefreshTokenStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Refresh token storage failed during ${this.operation}.`;
  }
}

export class McpRefreshTokens extends Context.Service<
  McpRefreshTokens,
  {
    /** The first refresh token of a session, at the authorization code exchange. */
    readonly issue: (
      input: McpRefreshGrant & { readonly clientId: string },
    ) => Effect.Effect<string, McpRefreshTokenStoreError>;
    readonly renew: (input: {
      readonly refreshToken: string;
      readonly clientId: string;
    }) => Effect.Effect<
      McpRenewedSession,
      McpRefreshTokenRejectedError | McpRefreshTokenStoreError
    >;
  }
>()("t3/auth/McpRefreshTokens") {}

interface StoredToken {
  readonly sessionId: AuthSessionId;
  readonly clientIdHash: string;
  readonly access: string;
  readonly peerLink: number;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly replacedBy: string | null;
  /** Null when the session row is gone. */
  readonly sessionRevokedAt: string | null;
  readonly sessionFound: number;
}

type Rotation =
  | { readonly _tag: "rotated"; readonly renewed: McpRenewedSession }
  | { readonly _tag: "replayed"; readonly sessionId: AuthSessionId };

const isAccess = Schema.is(AuthMcpClientAccess);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* SessionStore.SessionStore;

  const hash = (value: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(value))
      .pipe(Effect.orDie, Effect.map(base64UrlEncode));

  const storeFailure = (operation: string) => (cause: unknown) =>
    new McpRefreshTokenStoreError({ operation, cause });

  /** Writes a new token row and answers the token. Callers own the transaction. */
  const insertToken = Effect.fn("McpRefreshTokens.insertToken")(function* (
    grant: McpRefreshGrant,
    clientIdHash: string,
    now: DateTime.Utc,
  ) {
    const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
    const token = `${TOKEN_PREFIX}${base64UrlEncode(bytes)}`;
    const tokenHash = yield* hash(token);
    const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(MCP_REFRESH_TOKEN_TTL) });
    // Spent tokens stay until they expire, so a replay is still recognised.
    yield* sql`
      DELETE FROM mesura_mcp_refresh_tokens WHERE expires_at <= ${DateTime.formatIso(now)}
    `;
    yield* sql`
      INSERT INTO mesura_mcp_refresh_tokens (
        token_hash, session_id, client_id_hash, access, peer_link, issued_at, expires_at
      ) VALUES (
        ${tokenHash}, ${grant.sessionId}, ${clientIdHash}, ${grant.access},
        ${grant.peerLink ? 1 : 0}, ${DateTime.formatIso(now)}, ${DateTime.formatIso(expiresAt)}
      )
    `;
    return { token, tokenHash };
  });

  const issue: McpRefreshTokens["Service"]["issue"] = Effect.fn("McpRefreshTokens.issue")(
    function* (input) {
      const now = yield* DateTime.now;
      const clientIdHash = yield* hash(input.clientId);
      const { token } = yield* insertToken(input, clientIdHash, now).pipe(
        Effect.mapError(storeFailure("issue")),
      );
      return token;
    },
  );

  const findToken = (tokenHash: string) =>
    sql<StoredToken>`
      SELECT
        t.session_id AS "sessionId",
        t.client_id_hash AS "clientIdHash",
        t.access AS "access",
        t.peer_link AS "peerLink",
        t.expires_at AS "expiresAt",
        t.used_at AS "usedAt",
        t.replaced_by AS "replacedBy",
        s.revoked_at AS "sessionRevokedAt",
        s.session_id IS NOT NULL AS "sessionFound"
      FROM mesura_mcp_refresh_tokens t
      LEFT JOIN auth_sessions s ON s.session_id = t.session_id
      WHERE t.token_hash = ${tokenHash}
    `.pipe(Effect.map((rows) => rows[0]));

  /**
   * A retry replaces what the first use issued, and everything rotated from it since, so one chain
   * stays usable. The retired tokens are deleted, not marked spent: a spent token inside its own
   * window would count as a retry and start a parallel chain.
   */
  const retireDescendants = (tokenHash: string) =>
    sql`
      WITH RECURSIVE descendants(token_hash) AS (
        SELECT replaced_by FROM mesura_mcp_refresh_tokens
        WHERE token_hash = ${tokenHash} AND replaced_by IS NOT NULL
        UNION
        SELECT t.replaced_by FROM mesura_mcp_refresh_tokens t
        JOIN descendants d ON t.token_hash = d.token_hash
        WHERE t.replaced_by IS NOT NULL
      )
      DELETE FROM mesura_mcp_refresh_tokens
      WHERE token_hash IN (SELECT token_hash FROM descendants)
    `;

  const rotate = Effect.fn("McpRefreshTokens.rotate")(function* (
    tokenHash: string,
    clientIdHash: string,
  ) {
    const now = yield* DateTime.now;
    const stored = yield* findToken(tokenHash);
    const reject = (reason: McpRefreshTokenRejectedError["reason"]) =>
      Effect.fail(new McpRefreshTokenRejectedError({ reason }));
    if (stored === undefined || !isAccess(stored.access)) return yield* reject("unknown");
    if (stored.clientIdHash !== clientIdHash) return yield* reject("other-client");
    if (!stored.sessionFound || stored.sessionRevokedAt !== null) {
      return yield* reject("session-revoked");
    }
    if (Date.parse(stored.expiresAt) <= now.epochMilliseconds) return yield* reject("expired");
    if (stored.usedAt !== null) {
      const sinceFirstUse = now.epochMilliseconds - Date.parse(stored.usedAt);
      if (sinceFirstUse >= Duration.toMillis(MCP_REFRESH_RETRY_WINDOW)) {
        return { _tag: "replayed", sessionId: stored.sessionId } satisfies Rotation;
      }
      yield* retireDescendants(tokenHash);
    }
    const grant: McpRefreshGrant = {
      sessionId: stored.sessionId,
      access: stored.access,
      peerLink: stored.peerLink === 1,
    };
    const successor = yield* insertToken(grant, clientIdHash, now);
    // The first use stays recorded, so a retry window never restarts.
    yield* sql`
      UPDATE mesura_mcp_refresh_tokens
      SET used_at = COALESCE(used_at, ${DateTime.formatIso(now)}), replaced_by = ${successor.tokenHash}
      WHERE token_hash = ${tokenHash}
    `;
    const reissued = yield* sessions.reissue({
      sessionId: grant.sessionId,
      ttl: MCP_CLIENT_SESSION_TTL,
      ...(grant.access === "read-only" ? {} : { runtimeModeCeiling: grant.access }),
      peerLink: grant.peerLink,
    });
    return {
      _tag: "rotated",
      renewed: {
        ...grant,
        token: reissued.token,
        expiresAt: reissued.expiresAt,
        refreshToken: successor.token,
      },
    } satisfies Rotation;
  });

  const renew: McpRefreshTokens["Service"]["renew"] = Effect.fn("McpRefreshTokens.renew")(
    function* (input) {
      if (!TOKEN_PATTERN.test(input.refreshToken)) {
        return yield* new McpRefreshTokenRejectedError({ reason: "unknown" });
      }
      const tokenHash = yield* hash(input.refreshToken);
      const clientIdHash = yield* hash(input.clientId);
      const rotation = yield* sql
        .withTransaction(rotate(tokenHash, clientIdHash))
        .pipe(
          Effect.mapError((error) =>
            error._tag === "McpRefreshTokenRejectedError"
              ? error
              : SessionStore.isSessionCredentialInvalidError(error)
                ? new McpRefreshTokenRejectedError({ reason: "session-revoked" })
                : storeFailure("renew")(error),
          ),
        );
      if (rotation._tag === "rotated") return rotation.renewed;
      yield* sessions
        .revoke(rotation.sessionId)
        .pipe(Effect.mapError(storeFailure("revoke after replay")));
      yield* Effect.logWarning("Revoked an MCP client session after a refresh token replay.", {
        sessionId: rotation.sessionId,
      });
      return yield* new McpRefreshTokenRejectedError({ reason: "replayed" });
    },
  );

  return McpRefreshTokens.of({ issue, renew });
});

export const layer = Layer.effect(McpRefreshTokens, make);
