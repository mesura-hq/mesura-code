/**
 * DOM stand-ins for the native modules the Hosts fence mounts through: the
 * `react-native` primitives, `react-native-svg`, `uniwind`, and the app's text
 * and symbol components. Imported by tests only, from `vi.mock` factories:
 *
 *   vi.mock("react-native", async () =>
 *     (await import("../hosts/reactNativeDomTestDoubles")).reactNativeDom);
 *
 * What a user reads or presses keeps its meaning in the DOM: `accessibilityLabel`
 * becomes `aria-label`, `testID` becomes `data-testid`, `onPress` a click, and
 * `RefreshControl` records every `refreshing` value it is rendered with, so a
 * test can tell a spinner that ended from one that never started.
 */
import { createElement, useEffect, type PropsWithChildren, type ReactNode } from "react";

type AnyProps = PropsWithChildren<Record<string, unknown>>;

function domProps(props: AnyProps): Record<string, unknown> {
  return {
    "aria-label": props.accessibilityLabel as string | undefined,
    "data-testid": props.testID as string | undefined,
    className: props.className as string | undefined,
  };
}

function renderChildren(children: unknown): ReactNode {
  return typeof children === "function"
    ? (children as (state: { pressed: boolean }) => ReactNode)({ pressed: false })
    : (children as ReactNode);
}

function View(props: AnyProps) {
  return createElement("div", domProps(props), renderChildren(props.children));
}

function Text(props: AnyProps) {
  return createElement("span", domProps(props), props.children as ReactNode);
}

function Pressable(props: AnyProps) {
  return createElement(
    "button",
    {
      ...domProps(props),
      type: "button",
      disabled: props.disabled === true,
      onClick: () => (props.onPress as (() => void) | undefined)?.(),
    },
    renderChildren(props.children),
  );
}

function TextInput(props: AnyProps) {
  return createElement("input", {
    ...domProps(props),
    value: (props.value as string | undefined) ?? "",
    placeholder: props.placeholder as string | undefined,
    onChange: (event: { target: { value: string } }) =>
      (props.onChangeText as ((value: string) => void) | undefined)?.(event.target.value),
  });
}

function ScrollView(props: AnyProps) {
  return createElement(
    "div",
    domProps(props),
    props.refreshControl as ReactNode,
    props.children as ReactNode,
  );
}

/** Every `refreshing` value a `RefreshControl` was rendered with, in order. */
export const refreshControlLog: { values: boolean[] } = { values: [] };

function RefreshControl(props: AnyProps) {
  const refreshing = props.refreshing === true;
  refreshControlLog.values.push(refreshing);
  return createElement("button", {
    type: "button",
    "data-testid": "refresh-control",
    "data-refreshing": String(refreshing),
    onClick: () => (props.onRefresh as (() => void) | undefined)?.(),
  });
}

function FlatList(props: AnyProps) {
  const data = (props.data as ReadonlyArray<unknown> | undefined) ?? [];
  const renderItem = props.renderItem as (info: { item: unknown; index: number }) => ReactNode;
  const keyExtractor = props.keyExtractor as ((item: unknown, index: number) => string) | undefined;
  if (data.length === 0) return (props.ListEmptyComponent as ReactNode) ?? null;
  return createElement(
    "div",
    null,
    data.map((item, index) =>
      createElement(
        "div",
        { key: keyExtractor?.(item, index) ?? String(index) },
        renderItem({ item, index }),
      ),
    ),
  );
}

/** Calls `onDismiss` once it is hidden, as UIKit does after its fade. */
function Modal(props: AnyProps) {
  const visible = props.visible !== false;
  const onDismiss = props.onDismiss as (() => void) | undefined;
  useEffect(() => {
    if (!visible) onDismiss?.();
  }, [visible, onDismiss]);
  return visible ? createElement("div", { role: "dialog" }, props.children as ReactNode) : null;
}

type AppStateStatus = "active" | "background" | "inactive";

/** The app's foreground state, driven by the test through `setAppState`. */
export const appStateControl = {
  current: "active" as AppStateStatus,
  listeners: new Set<(state: AppStateStatus) => void>(),
};

export function setAppState(next: AppStateStatus): void {
  appStateControl.current = next;
  for (const listener of [...appStateControl.listeners]) listener(next);
}

const AppState = {
  get currentState() {
    return appStateControl.current;
  },
  addEventListener: (_type: "change", listener: (state: AppStateStatus) => void) => {
    appStateControl.listeners.add(listener);
    return { remove: () => appStateControl.listeners.delete(listener) };
  },
};

/** Renders only its children: for wrappers whose native chrome the tests do not need. */
export const passthrough = (props: AnyProps) => renderChildren(props.children);

export const reactNativeDom = {
  Platform: {
    OS: "android",
    Version: 35,
    select: <T,>(options: { android?: T; default?: T }) => options.android ?? options.default,
  },
  View,
  Text,
  Pressable,
  TouchableOpacity: Pressable,
  TextInput,
  ScrollView,
  RefreshControl,
  FlatList,
  Modal,
  KeyboardAvoidingView: View,
  ActivityIndicator: () => null,
  AppState,
  Alert: { alert: () => undefined },
  Linking: { openURL: async () => undefined, openSettings: async () => undefined },
  StyleSheet: {
    create: <T,>(styles: T) => styles,
    flatten: (style: unknown) => style,
    hairlineWidth: 1,
    absoluteFill: {},
    absoluteFillObject: {},
  },
  useWindowDimensions: () => ({ width: 412, height: 915, scale: 2, fontScale: 1 }),
  useColorScheme: () => "light",
  I18nManager: { isRTL: false },
  Dimensions: { get: () => ({ width: 412, height: 915 }) },
};

function svgElement(tag: string) {
  return function SvgElement(props: AnyProps) {
    const { children, accessibilityLabel, testID, colorClassName, className, ...rest } = props;
    const attributes: Record<string, unknown> = {
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      "data-color-class": colorClassName ?? className,
    };
    for (const [key, value] of Object.entries(rest)) {
      if (typeof value === "string" || typeof value === "number") attributes[key] = value;
    }
    return createElement(tag, attributes, children as ReactNode);
  };
}

const Svg = svgElement("svg");

export const reactNativeSvgDom = {
  __esModule: true,
  default: Svg,
  Svg,
  Path: svgElement("path"),
  Line: svgElement("line"),
  Rect: svgElement("rect"),
  Circle: svgElement("circle"),
  G: svgElement("g"),
  Defs: svgElement("defs"),
  LinearGradient: svgElement("linearGradient"),
  Stop: svgElement("stop"),
};

export const uniwindDom = {
  withUniwind: <T,>(component: T) => component,
  useResolveClassNames: () => ({}),
  useUniwind: () => ({ theme: "light" }),
  Uniwind: { setTheme: () => undefined },
};

export const appTextDom = {
  AppText: Text,
  AppTextInput: TextInput,
};

export const appSymbolDom = {
  SymbolView: () => null,
};
