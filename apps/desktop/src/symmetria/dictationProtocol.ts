import {
  decodeSymmetriaProtocolVersion,
  SymmetriaDictationCommand,
  type SymmetriaDictationCommand as DictationCommand,
  SymmetriaDictationReceipt,
  type SymmetriaDictationReceipt as DictationReceipt,
  type SymmetriaDictationSession as DictationSession,
  SymmetriaDictationSessionId,
  SymmetriaDictationSource,
  SymmetriaProtocolVersion,
} from "@symmetria/broker-contract";
import { CommandId, IsoDateTime } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const DICTATION_CAPABILITIES = [
  "session-control",
  "mode-selection",
  "target-reservation",
  "delivery-receipts",
] as const;

const DictationHello = Schema.Struct({
  type: Schema.Literal("dictation.hello"),
  protocolVersion: Schema.Unknown,
  capabilities: Schema.Array(Schema.String),
});

const DictationReserveRequestSchema = Schema.Struct({
  type: Schema.Literal("dictation.reserve.request"),
  protocolVersion: SymmetriaProtocolVersion,
  sessionId: SymmetriaDictationSessionId,
  commandId: CommandId,
  createdAt: IsoDateTime,
  source: SymmetriaDictationSource,
});

export type DictationReserveRequest = typeof DictationReserveRequestSchema.Type;
export type DictationClientMessage =
  | typeof DictationHello.Type
  | DictationReserveRequest
  | DictationCommand;

export type DictationServerMessage =
  | {
      readonly type: "dictation.hello";
      readonly protocolVersion: { readonly major: 1; readonly minor: number };
      readonly capabilities: ReadonlyArray<string>;
    }
  | { readonly type: "dictation.snapshot"; readonly session: DictationSession | null }
  | { readonly type: "dictation.receipt"; readonly receipt: DictationReceipt }
  | {
      readonly type: "dictation.error";
      readonly code: "malformed_input" | "unsupported_protocol";
      readonly detail: string;
    };

export type DictationRendererFrame = {
  readonly revision: number;
  readonly session: DictationSession | null;
};

export type DictationProtocolParseResult =
  | { readonly ok: true; readonly message: DictationClientMessage }
  | {
      readonly ok: false;
      readonly code: "malformed_input" | "unsupported_protocol";
      readonly detail: string;
    };

const decodeHello = Schema.decodeUnknownResult(DictationHello);
const decodeReserve = Schema.decodeUnknownResult(DictationReserveRequestSchema);
const decodeCommand = Schema.decodeUnknownResult(SymmetriaDictationCommand);
const decodeReceipt = Schema.decodeUnknownResult(SymmetriaDictationReceipt);

export function parseDictationClientLine(line: string): DictationProtocolParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (cause) {
    return {
      ok: false,
      code: "malformed_input",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  return parseDictationClientMessage(raw);
}

export function parseDictationClientMessage(raw: unknown): DictationProtocolParseResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, code: "malformed_input", detail: "message must be an object" };
  }

  const announcedVersion = (raw as Record<string, unknown>)["protocolVersion"];
  const version = decodeSymmetriaProtocolVersion(announcedVersion);
  if (Result.isFailure(version)) {
    return {
      ok: false,
      code:
        version.failure._tag === "SymmetriaProtocolVersionMismatch"
          ? "unsupported_protocol"
          : "malformed_input",
      detail:
        version.failure._tag === "SymmetriaProtocolVersionMismatch"
          ? `unsupported protocol major ${version.failure.receivedMajor}`
          : version.failure.issue,
    };
  }

  const type = (raw as Record<string, unknown>)["type"];
  if (type === "dictation.hello") {
    const decoded = decodeHello(raw);
    return Result.isFailure(decoded)
      ? { ok: false, code: "malformed_input", detail: decoded.failure.message }
      : { ok: true, message: decoded.success };
  }
  if (type === "dictation.reserve.request") {
    const decoded = decodeReserve(raw);
    return Result.isFailure(decoded)
      ? { ok: false, code: "malformed_input", detail: decoded.failure.message }
      : { ok: true, message: decoded.success };
  }
  const decoded = decodeCommand(raw);
  return Result.isFailure(decoded)
    ? { ok: false, code: "malformed_input", detail: decoded.failure.message }
    : { ok: true, message: decoded.success };
}

export function parseDictationReceipt(raw: unknown): DictationReceipt | null {
  const decoded = decodeReceipt(raw);
  return Result.isSuccess(decoded) ? decoded.success : null;
}

export function formatDictationServerMessage(message: DictationServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Keeps a renderer reload ordered while its listener and snapshot request attach separately. */
export function subscribeToOrderedRendererFrames(options: {
  readonly load: () => Promise<DictationRendererFrame>;
  readonly attach: (listener: (frame: DictationRendererFrame) => void) => () => void;
  readonly listener: (session: DictationSession | null) => void;
  readonly onError?: (error: Error) => void;
}): () => void {
  let active = true;
  let opening = true;
  let revision = -1;
  const queued: Array<DictationRendererFrame> = [];
  const unsubscribe = options.attach((frame) => {
    if (!active) return;
    if (opening) {
      queued.push(frame);
      return;
    }
    if (frame.revision <= revision) return;
    revision = frame.revision;
    options.listener(frame.session);
  });

  void options
    .load()
    .then((frame) => {
      if (!active) return;
      revision = frame.revision;
      options.listener(frame.session);
      opening = false;
      queued.sort((left, right) => left.revision - right.revision);
      for (const pending of queued) {
        if (pending.revision <= revision) continue;
        revision = pending.revision;
        options.listener(pending.session);
      }
      queued.length = 0;
    })
    .catch((cause) => {
      opening = false;
      queued.sort((left, right) => left.revision - right.revision);
      for (const pending of queued) {
        if (pending.revision <= revision) continue;
        revision = pending.revision;
        options.listener(pending.session);
      }
      queued.length = 0;
      options.onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    });

  return () => {
    active = false;
    queued.length = 0;
    unsubscribe();
  };
}
