import {
  DICTATION_WIDGET_TITLE,
  WIDGET_BOTTOM_MARGIN,
  WIDGET_HEIGHT,
  WIDGET_WIDTH,
} from "./DictationWidgetWindow.ts";
import {
  generatedKeyword,
  isHyprlandSession,
  runKeywordCommands,
  type HyprctlExecute,
  type KeywordCommand,
} from "./hyprctl.ts";

/**
 * Applied at runtime so no dotfile carries them: Hyprland ignores a Wayland client's position and
 * size unless a rule floats it. Named rules (`windowrule[name]:effect value`), because a second
 * process then replaces the keys; anonymous runtime rules stack until a reload, and Hyprland
 * 0.56.2 cannot remove one.
 */
const RULE_NAME = "mesura-dictation-widget";

/** A monitor as far as placement reads it: its name and its reserved bottom edge. */
export interface WidgetMonitor {
  readonly name: string;
  readonly reservedBottom: number;
}

/**
 * Names that fit both `m[…]` (which ends at the first `]`) and a rule name; another name keeps
 * the base rule's placement.
 */
const SELECTABLE_MONITOR = /^[\w-]+$/;

/**
 * Use the widget's own size, not `window_w`/`window_h`: on first map Hyprland 0.56.2 reads those
 * from the requested geometry, the whole monitor for a Wayland window, and opens it monitor-sized.
 * `monitor_h` is the whole monitor, so each monitor gets a placement rule that includes its
 * reserved bottom; the later rule's `move` wins and the base rule serves unlisted monitors.
 */
const moveToBottomCentre = (reservedBottom: number) =>
  `(monitor_w*0.5-${WIDGET_WIDTH / 2}) (monitor_h-${WIDGET_HEIGHT}-${
    WIDGET_BOTTOM_MARGIN + reservedBottom
  })`;

export function hyprlandWidgetRuleCommands(input: {
  readonly monitors: ReadonlyArray<WidgetMonitor>;
}): ReadonlyArray<KeywordCommand> {
  const title = `^(${DICTATION_WIDGET_TITLE})$`;
  const key = (rule: string, name: string, value: string) =>
    generatedKeyword(`windowrule[${rule}]:${name}`, value);
  const base = (name: string, value: string) => key(RULE_NAME, name, value);
  return [
    base("match:title", title),
    base("float", "on"),
    base("pin", "on"),
    base("no_initial_focus", "on"),
    base("no_focus", "on"),
    base("border_size", "0"),
    base("rounding", "0"),
    base("no_shadow", "on"),
    base("no_blur", "on"),
    base("size", `${WIDGET_WIDTH} ${WIDGET_HEIGHT}`),
    base("move", moveToBottomCentre(0)),
    ...input.monitors
      .filter((monitor) => SELECTABLE_MONITOR.test(monitor.name))
      .flatMap((monitor) => {
        const rule = `${RULE_NAME}-${monitor.name}`;
        return [
          key(rule, "match:title", title),
          key(rule, "match:workspace", `m[${monitor.name}]`),
          key(rule, "move", moveToBottomCentre(monitor.reservedBottom)),
        ];
      }),
  ];
}

/** Every monitor in `hyprctl -j monitors` with its reserved bottom; throws on bad output. */
function parseWidgetMonitors(json: string): ReadonlyArray<WidgetMonitor> {
  const monitors: unknown = JSON.parse(json);
  if (!Array.isArray(monitors)) throw new Error("hyprctl monitors did not return a list.");
  return monitors.flatMap((raw: unknown): WidgetMonitor[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const { name, reserved } = raw as Record<string, unknown>;
    if (typeof name !== "string") return [];
    const bottom = Array.isArray(reserved) ? reserved[3] : 0;
    return [{ name, reservedBottom: typeof bottom === "number" && bottom > 0 ? bottom : 0 }];
  });
}

export function createHyprlandWidgetRules(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execute: HyprctlExecute;
  readonly onError?: (cause: unknown) => void;
}): {
  /** Whether this process runs under Hyprland, the only place the rules go. */
  readonly enabled: boolean;
  /** Applies the rules once per process; never rejects, and logs what fails. */
  readonly apply: () => Promise<void>;
} {
  const enabled = isHyprlandSession(input.env);
  let applied: Promise<void> | null = null;

  const run = async () => {
    // Read once per process: a monitor connected later gets the base rule's plain margin, and
    // a bottom bar that starts or resizes later keeps the value read here.
    let monitors: ReadonlyArray<WidgetMonitor> = [];
    try {
      const output = await input.execute("hyprctl", ["-j", "monitors"]);
      monitors = parseWidgetMonitors(output?.stdout ?? "");
    } catch (cause) {
      input.onError?.(cause);
    }
    const rejections = await runKeywordCommands(
      input.execute,
      hyprlandWidgetRuleCommands({ monitors }),
    );
    if (rejections.length > 0) input.onError?.(new Error(rejections.join("; ")));
  };

  const apply = () => {
    if (!enabled) return Promise.resolve();
    applied ??= run().catch((cause: unknown) => input.onError?.(cause));
    return applied;
  };

  return { enabled, apply };
}
