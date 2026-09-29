import { memo, useCallback, useMemo, useState, type ComponentProps } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  MERMAID_PAGE_BASE_URL,
  buildMermaidPageHtml,
  parseMermaidPageMessage,
} from "./mermaidPage";

type WebViewProps = ComponentProps<typeof WebView>;
type WebViewMessageEvent = Parameters<NonNullable<WebViewProps["onMessage"]>>[0];
type ShouldStartLoadRequest = Parameters<
  NonNullable<WebViewProps["onShouldStartLoadWithRequest"]>
>[0];

/** Room the view keeps while the page measures the drawn diagram. */
const MEASURING_HEIGHT = 160;

type DiagramStatus =
  | { readonly status: "drawing" }
  | { readonly status: "drawn"; readonly height: number }
  | { readonly status: "offline" }
  | { readonly status: "invalid"; readonly message: string };

/** A status belongs to one page and one attempt; a new page or a retry draws afresh. */
type DiagramState = DiagramStatus & { readonly html: string; readonly attempt: number };

function DiagramSource(props: {
  readonly source: string;
  readonly reason: string;
  readonly onRetry?: () => void;
}) {
  return (
    <View className="gap-2 px-3 py-3">
      <View className="flex-row items-center gap-3">
        <Text className="min-w-0 flex-1 text-xs text-foreground-muted">{props.reason}</Text>
        {props.onRetry ? (
          <Pressable
            accessibilityRole="button"
            className="min-h-9 justify-center rounded-lg border border-border bg-subtle px-3 active:opacity-65"
            onPress={props.onRetry}
          >
            <Text className="font-t3-bold text-xs text-foreground">Try again</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView horizontal>
        <Text selectable className="font-mono text-xs text-foreground">
          {props.source}
        </Text>
      </ScrollView>
    </View>
  );
}

// The page is ours and static: nothing in it may navigate the WebView away.
function allowsOnlyThePage(request: ShouldStartLoadRequest): boolean {
  return request.url === MERMAID_PAGE_BASE_URL || request.url.startsWith("about:");
}

/**
 * A Mermaid diagram drawn in a WebView at its natural height. Without the
 * network the page cannot load Mermaid; the source shows instead, with why.
 */
export const MermaidWebView = memo(function MermaidWebView(props: { readonly source: string }) {
  const { themeAppearance } = useAppearancePreferences();
  const html = useMemo(
    () => buildMermaidPageHtml({ source: props.source, appearance: themeAppearance }),
    [props.source, themeAppearance],
  );
  const [state, setState] = useState<DiagramState>({ status: "drawing", html, attempt: 0 });
  // A revised diagram or a theme change starts a new page, whatever the last one reported.
  const current: DiagramState =
    state.html === html ? state : { status: "drawing", html, attempt: state.attempt };
  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const message = parseMermaidPageMessage(event.nativeEvent.data);
      if (message === null) return;
      const next: DiagramStatus =
        message.type === "height"
          ? { status: "drawn", height: message.height }
          : message.type === "error"
            ? { status: "offline" }
            : { status: "invalid", message: message.message };
      setState((previous) => ({ ...next, html, attempt: previous.attempt }));
    },
    [html],
  );
  const onLoadError = useCallback(() => {
    setState((previous) => ({ status: "offline", html, attempt: previous.attempt }));
  }, [html]);
  const retry = useCallback(() => {
    setState((previous) => ({ status: "drawing", html, attempt: previous.attempt + 1 }));
  }, [html]);

  if (current.status === "offline") {
    return (
      <DiagramSource
        source={props.source}
        reason="Diagrams need a network connection."
        onRetry={retry}
      />
    );
  }
  if (current.status === "invalid") {
    return (
      <DiagramSource
        source={props.source}
        reason={`The diagram could not be drawn: ${current.message}`}
      />
    );
  }
  return (
    <View style={{ height: current.status === "drawn" ? current.height : MEASURING_HEIGHT }}>
      <WebView
        key={current.attempt}
        source={{ html, baseUrl: MERMAID_PAGE_BASE_URL }}
        originWhitelist={["https://*", "about:*"]}
        onShouldStartLoadWithRequest={allowsOnlyThePage}
        onMessage={onMessage}
        onError={onLoadError}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        style={{ backgroundColor: "transparent" }}
      />
    </View>
  );
});
