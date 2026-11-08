import { ThreadSearchToolError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { requireMcpCapability, requireThreadScope } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ThreadSearchBroker } from "../../ThreadSearchBroker.ts";
import { ThreadSearchToolkit } from "./tools.ts";

const noBroker = new ThreadSearchToolError({
  message: "Thread search is not available on this server.",
});

const make = Effect.gen(function* () {
  // Optional, so a server built without the WebSocket side still registers
  // every toolkit; the server's routes layer provides it to both transports.
  const broker = yield* Effect.serviceOption(ThreadSearchBroker);
  const findThreads = Effect.fn("ThreadSearchToolkit.findThreads")(function* (input: {
    readonly description: string;
  }) {
    // Only search conversations hold the capability (ProviderSessionManager).
    const scope = yield* requireMcpCapability("thread-search");
    const caller = yield* requireThreadScope(scope, "find_threads");
    if (Option.isNone(broker)) return yield* noBroker;
    return yield* broker.value.invoke(caller.thread.threadId, input.description);
  });
  return {
    // Reads on behalf of the calling search conversation, which must be a thread.
    find_threads: McpToolAccess.readsAsCaller(findThreads),
  } satisfies McpToolAccess.Handlers<typeof ThreadSearchToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(ThreadSearchToolkit, make);
