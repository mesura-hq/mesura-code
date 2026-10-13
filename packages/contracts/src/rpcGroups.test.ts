import { describe, expect, it } from "vite-plus/test";

import { WS_METHODS, WsRpcGroup, WsRpcGroupMesura, WsRpcGroupUpstream } from "./rpc.ts";
import { THREAD_SEARCH_WS_METHODS } from "./threadSearchEvidence.ts";

// Mesura: the server builds one handler layer per part (ws.ts, wsMesura.ts) and
// serves the merged group. A method in neither part would have no handler; a
// method in both would get two.
describe("WebSocket RPC group parts", () => {
  const all = [...WsRpcGroup.requests.keys()].toSorted();
  const upstream = [...WsRpcGroupUpstream.requests.keys()];
  const mesura = [...WsRpcGroupMesura.requests.keys()];

  it("splits every RPC into exactly one part", () => {
    expect([...upstream, ...mesura].toSorted()).toEqual(all);
    expect(upstream.filter((method) => mesura.includes(method))).toEqual([]);
  });

  it("keeps the fork's RPCs in the Mesura part", () => {
    expect(mesura).toEqual(
      expect.arrayContaining([
        WS_METHODS.issuesList,
        WS_METHODS.dictationStart,
        WS_METHODS.projectIconsDiscover,
        WS_METHODS.fileManagerQuery,
        WS_METHODS.subscribeFactoryRun,
        WS_METHODS.editorSessionOpen,
        WS_METHODS.subscribeHostStats,
        WS_METHODS.serverGetAccountLimits,
        ...Object.values(THREAD_SEARCH_WS_METHODS),
      ]),
    );
  });
});
