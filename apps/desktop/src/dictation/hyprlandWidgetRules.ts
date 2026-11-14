import {
  DICTATION_WIDGET_TITLE,
  WIDGET_BOTTOM_MARGIN,
  WIDGET_HEIGHT,
  WIDGET_WIDTH,
} from "./DictationWidgetWindow.ts";
import {
  generatedKeyword,
  isHyprlandSession,
  luaString,
  luaTable,
  luaValue,
  createHyprlandConfigProviderReader,
  runKeywordCommands,
  runLuaEval,
  type HyprctlExecute,
  type KeywordCommand,
} from "./hyprctl.ts";

/**
 * Applied at runtime so no dotfile carries them: Hyprland ignores a Wayland client's position and
 * size unless a rule floats it. Under Hyprlang they are named rules (`windowrule[name]:effect
 * value`), because a second process then replaces the keys; anonymous runtime rules stack until a
 * reload, and Hyprland 0.56.2 cannot remove one.
 */
const RULE_NAME = "mesura-dictation-widget";

/**
 * Under a Lua config the rules are anonymous `hl.window_rule` handles in this global, keyed by
 * their Lua text. An apply enables the ones it sends again and disables the rest: Hyprland 0.57.1
 * appends a named rule's effects each time it is sent, and keeps every anonymous one it gets.
 */
const LUA_RULES_GLOBAL = "__mesura_dictation_widget_rules";

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

type RuleValue = string | number | boolean;

/** One rule as both config languages write it: what it matches, then its effects in order. */
interface WidgetRule {
  readonly name: string;
  readonly match: ReadonlyArray<readonly [field: string, value: string]>;
  readonly effects: ReadonlyArray<readonly [effect: string, value: RuleValue]>;
}

function widgetRules(input: { readonly monitors: ReadonlyArray<WidgetMonitor> }): WidgetRule[] {
  const title: readonly [string, string] = ["title", `^(${DICTATION_WIDGET_TITLE})$`];
  return [
    {
      name: RULE_NAME,
      match: [title],
      effects: [
        ["float", true],
        ["pin", true],
        ["no_initial_focus", true],
        ["no_focus", true],
        ["border_size", 0],
        ["rounding", 0],
        ["no_shadow", true],
        ["no_blur", true],
        ["size", `${WIDGET_WIDTH} ${WIDGET_HEIGHT}`],
        ["move", moveToBottomCentre(0)],
      ],
    },
    ...input.monitors
      .filter((monitor) => SELECTABLE_MONITOR.test(monitor.name))
      .map((monitor) => ({
        name: `${RULE_NAME}-${monitor.name}`,
        match: [title, ["workspace", `m[${monitor.name}]`] as const],
        effects: [["move", moveToBottomCentre(monitor.reservedBottom)] as const],
      })),
  ];
}

const hyprlangValue = (value: RuleValue) =>
  typeof value === "boolean" ? (value ? "on" : "off") : String(value);

export function hyprlandWidgetRuleCommands(input: {
  readonly monitors: ReadonlyArray<WidgetMonitor>;
}): ReadonlyArray<KeywordCommand> {
  return widgetRules(input).flatMap((rule) => {
    const key = (name: string, value: string) =>
      generatedKeyword(`windowrule[${rule.name}]:${name}`, value);
    return [
      ...rule.match.map(([field, value]) => key(`match:${field}`, value)),
      ...rule.effects.map(([effect, value]) => key(effect, hyprlangValue(value))),
    ];
  });
}

/** The same rules for a Lua config, reusing the ones a previous apply left, from any process. */
export function hyprlandWidgetRuleLua(input: {
  readonly monitors: ReadonlyArray<WidgetMonitor>;
}): string {
  const rules = widgetRules(input).map((rule) => {
    const call = `hl.window_rule(${luaTable([
      ["match", luaTable(rule.match.map(([field, value]) => [field, luaString(value)] as const))],
      ...rule.effects.map(([effect, value]) => [effect, luaValue(value)] as const),
    ])})`;
    return `rule(${luaString(call)}, function() return ${call} end)`;
  });
  return [
    `local previous = _G.${LUA_RULES_GLOBAL} or {} local kept = {}`,
    "local function rule(key, make) local handle = previous[key] previous[key] = nil",
    "if not (handle and pcall(handle.set_enabled, handle, true)) then handle = make() end",
    "kept[key] = handle end",
    ...rules,
    "for _, handle in pairs(previous) do pcall(handle.set_enabled, handle, false) end",
    `_G.${LUA_RULES_GLOBAL} = kept`,
  ].join(" ");
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
  /** Applies the rules once per process; never rejects, and logs what fails. A failure is not kept. */
  readonly apply: () => Promise<void>;
  /** Sends the rules again, with the monitors read again: a config reload dropped them. */
  readonly reapply: () => Promise<void>;
} {
  const enabled = isHyprlandSession(input.env);
  const readConfigProvider = createHyprlandConfigProviderReader(input.execute);
  let applied: Promise<void> | null = null;

  const run = async () => {
    // Read on each apply: until the next config reload, a monitor connected later gets the base
    // rule's plain margin, and a bottom bar that starts or resizes later keeps this value.
    let monitors: ReadonlyArray<WidgetMonitor> = [];
    try {
      const output = await input.execute("hyprctl", ["-j", "monitors"]);
      monitors = parseWidgetMonitors(output?.stdout ?? "");
    } catch (cause) {
      input.onError?.(cause);
    }
    const rejections =
      (await readConfigProvider()) === "lua"
        ? await runLuaEval(input.execute, hyprlandWidgetRuleLua({ monitors }))
        : await runKeywordCommands(input.execute, hyprlandWidgetRuleCommands({ monitors }));
    if (rejections.length > 0) throw new Error(rejections.join("; "));
  };

  const apply = () => {
    if (!enabled) return Promise.resolve();
    // Only a success is kept, so the next config reload sends rejected rules again.
    applied ??= run().catch((cause: unknown) => {
      applied = null;
      input.onError?.(cause);
    });
    return applied;
  };

  const reapply = () => {
    applied = null;
    return apply();
  };

  return { enabled, apply, reapply };
}
