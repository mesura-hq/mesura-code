import type {
  PreviewStreamClient,
  PreviewStreamControl,
} from "@t3tools/client-runtime/preview/server-browser-stream";

/** Read current socket/control refs at submission; never claim or take control. */
export function serverBrowserNavigation(
  client: () => PreviewStreamClient | null,
  control: () => PreviewStreamControl | null,
) {
  return {
    navigate: (url: string) => client()?.send({ type: "navigate", url }) ?? false,
    readiness: (): "waiting" | "ready" | "refused" => {
      const current = control();
      if (!client() || !current) return "waiting";
      return current.canOperate && current.controller === "you" ? "ready" : "refused";
    },
  };
}
