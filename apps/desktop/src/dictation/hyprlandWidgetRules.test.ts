/**
 * Entry point: `createHyprlandWidgetRules`; `hyprlandWidgetRuleCommands` is tested directly.
 * The fake runner mirrors Hyprland 0.56.2: `hyprctl keyword` and `--batch` exit 0 even when they
 * reject a rule and print the error text per command instead of `ok`. `hyprctl -j monitors`
 * reports `reserved` as `[left, top, right, bottom]`.
 */
import { describe, expect, it, vi } from "vite-plus/test";

import type { KeywordCommand } from "./hyprctl.ts";
import { createHyprlandWidgetRules, hyprlandWidgetRuleCommands } from "./hyprlandWidgetRules.ts";

const HYPRLAND = { HYPRLAND_INSTANCE_SIGNATURE: "fence_1792696316_1571868373" };
const TITLE_PATTERN = "^(mesura-dictation-overlay)$";
const BOTTOM_MARGIN = 24;

/** The bottom centre, `margin` above the monitor's bottom edge. */
const moveTo = (margin: number) => `(monitor_w*0.5-220) (monitor_h-64-${margin})`;

const expectedEffects = (margin: number) => ({
  float: "on",
  pin: "on",
  no_initial_focus: "on",
  no_focus: "on",
  border_size: "0",
  rounding: "0",
  no_shadow: "on",
  no_blur: "on",
  size: "440 64",
  move: moveTo(margin),
});

const NAMED_KEY = /^windowrule\[([\w-]+)\]:(.+)$/;

/**
 * The effects of the base rule, the one rule that matches the widget's title and nothing else.
 * Every rule the commands set must match exactly that title; the per-monitor placement rules
 * also select a monitor and carry only a `move`. The last value of a key wins, as in Hyprland.
 */
function effectsForWidgetTitle(
  commands: ReadonlyArray<Pick<KeywordCommand, "keyword" | "value">>,
): Record<string, string> {
  const bases: Array<Record<string, string>> = [];
  for (const fields of namedRules(commands).values()) {
    const { "match:title": title, "match:workspace": workspace, ...effects } = fields;
    expect(title).toBe(TITLE_PATTERN);
    expect(Object.keys(effects).filter((key) => key.startsWith("match:"))).toEqual([]);
    if (workspace === undefined) bases.push(effects);
    else expect(Object.keys(effects)).toEqual(["move"]);
  }
  expect(bases).toHaveLength(1);
  return bases[0]!;
}

/** A monitor as `hyprctl -j monitors` reports it on Hyprland 0.56.2, cut to what matters. */
const monitor = (fields: Record<string, unknown>) => ({
  id: 0,
  name: "eDP-1",
  width: 1920,
  height: 1200,
  x: 0,
  y: 0,
  scale: 1,
  focused: true,
  reserved: [0, 0, 0, 0],
  ...fields,
});

/**
 * `windowruleResult` is what Hyprland prints for each `windowrule` keyword; an Error makes every
 * `hyprctl` call fail, as a missing binary does.
 */
function makeRules(
  env: Record<string, string | undefined>,
  {
    windowruleResult = "ok",
    monitors = [monitor({})],
    failure,
  }: {
    windowruleResult?: string;
    monitors?: ReadonlyArray<Record<string, unknown>>;
    failure?: Error;
  } = {},
) {
  const execute = vi.fn(async (_file: string, args: ReadonlyArray<string>) => {
    if (failure) throw failure;
    if (args[0] === "-j" && args[1] === "monitors") return { stdout: JSON.stringify(monitors) };
    if (args[0] === "--batch") {
      const lines = args[1]!.split(" ; ");
      return {
        stdout: lines
          .map((line) => (line.startsWith("keyword windowrule") ? windowruleResult : "ok"))
          .join("\n\n\n"),
      };
    }
    if (args[0] === "keyword" && args[1]!.startsWith("windowrule"))
      return { stdout: windowruleResult };
    return { stdout: "ok" };
  });
  const onError = vi.fn();
  const rules = createHyprlandWidgetRules({ env, execute, onError });
  /** Every `windowrule…` keyword Hyprland received, from a batch or a single keyword call. */
  const windowruleValues = () =>
    execute.mock.calls.flatMap(([, args]) => {
      if (args[0] === "--batch")
        return args[1]!
          .split(" ; ")
          .filter((line) => line.startsWith("keyword windowrule"))
          .map((line) => {
            const [, keyword, ...value] = line.split(" ");
            return { keyword: keyword!, value: value.join(" ") };
          });
      if (args[0] === "keyword" && args[1]!.startsWith("windowrule"))
        return [{ keyword: args[1]!, value: args[2]! }];
      return [];
    });
  return { rules, execute, onError, windowruleValues };
}

describe("search unification phase 5 fence: the widget's Hyprland rule lines", () => {
  it("search unification phase 5 AC1: the rule values float, pin and unfocus the widget title and strip its frame", () => {
    const values = hyprlandWidgetRuleCommands({ monitors: [] });
    expect(values.length).toBeGreaterThan(0);
    expect(effectsForWidgetTitle(values)).toEqual(expectedEffects(BOTTOM_MARGIN));
  });

  it("search unification phase 5 AC2: the move rule centres the widget and keeps the bottom margin above a reserved bottom edge", () => {
    const commands = hyprlandWidgetRuleCommands({
      monitors: [
        { name: "eDP-1", reservedBottom: 0 },
        { name: "DP-2", reservedBottom: 36 },
      ],
    });
    expect(effectsForWidgetTitle(commands).move).toBe(moveTo(BOTTOM_MARGIN));
    expect(moveOnMonitor(commands, "eDP-1")).toBe(moveTo(BOTTOM_MARGIN));
    expect(moveOnMonitor(commands, "DP-2")).toBe(moveTo(BOTTOM_MARGIN + 36));
  });
});

describe("search unification phase 5 fence: applying the widget rules", () => {
  it("search unification phase 5 AC1: under Hyprland, apply sends every widget rule to hyprctl", async () => {
    const { rules, onError, windowruleValues } = makeRules(HYPRLAND);
    expect(rules.enabled).toBe(true);
    await rules.apply();
    expect(effectsForWidgetTitle(windowruleValues())).toEqual(expectedEffects(BOTTOM_MARGIN));
    expect(onError).not.toHaveBeenCalled();
  });

  it("search unification phase 5 AC2: the base rule keeps the plain margin for a monitor connected later", async () => {
    const { rules, windowruleValues } = makeRules(HYPRLAND, {
      monitors: [monitor({ id: 1, name: "eDP-1", focused: true, reserved: [0, 40, 0, 30] })],
    });
    await rules.apply();
    expect(effectsForWidgetTitle(windowruleValues()).move).toBe(moveTo(BOTTOM_MARGIN));
    expect(moveOnMonitor(windowruleValues(), "HDMI-A-1")).toBeUndefined();
  });

  it("search unification phase 5 AC3: a second apply sends no rule again", async () => {
    const { rules, windowruleValues } = makeRules(HYPRLAND);
    await rules.apply();
    const once = windowruleValues();
    await rules.apply();
    expect(windowruleValues()).toEqual(once);
  });

  it("reapply after a config reload sends every rule again, with the monitors read again", async () => {
    const { rules, execute, windowruleValues } = makeRules(HYPRLAND);
    await rules.apply();
    const once = windowruleValues();
    await rules.reapply();
    expect(windowruleValues()).toEqual([...once, ...once]);
    const monitorReads = execute.mock.calls.filter(([, args]) => args[1] === "monitors");
    expect(monitorReads).toHaveLength(2);
  });

  it("search unification phase 5 AC3: two applies started together send the rules once", async () => {
    const { rules, windowruleValues } = makeRules(HYPRLAND);
    await Promise.all([rules.apply(), rules.apply()]);
    const single = makeRules(HYPRLAND);
    await single.rules.apply();
    expect(windowruleValues()).toEqual(single.windowruleValues());
  });

  it("search unification phase 5 AC4: a missing hyprctl is logged and apply still resolves", async () => {
    const missing = Object.assign(new Error("spawn hyprctl ENOENT"), { code: "ENOENT" });
    const { rules, onError } = makeRules(HYPRLAND, { failure: missing });
    await expect(rules.apply()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it("search unification phase 5 AC4: a rule hyprctl rejects is logged with Hyprland's error text", async () => {
    const { rules, onError } = makeRules(HYPRLAND, {
      windowruleResult: "config option <windowrule:no_blur> does not exist.",
    });
    await expect(rules.apply()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
    const logged = onError.mock.calls.map(([cause]) =>
      cause instanceof Error ? cause.message : String(cause),
    );
    expect(logged.join("\n")).toContain("config option <windowrule:no_blur> does not exist.");
  });

  it("search unification phase 5 AC4: an unreadable monitor list still applies the rules with the plain margin", async () => {
    const { rules, windowruleValues } = makeRules(HYPRLAND, {
      monitors: "not a list" as unknown as ReadonlyArray<Record<string, unknown>>,
    });
    await rules.apply();
    expect(effectsForWidgetTitle(windowruleValues())).toEqual(expectedEffects(BOTTOM_MARGIN));
    expect(namedRules(windowruleValues()).size).toBe(1);
  });

  it("search unification phase 5 AC5: outside Hyprland no rule is applied", async () => {
    for (const env of [{}, { HYPRLAND_INSTANCE_SIGNATURE: "  " }]) {
      const { rules, execute, onError } = makeRules(env);
      expect(rules.enabled).toBe(false);
      await expect(rules.apply()).resolves.toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    }
  });
});

/** Each named rule's keys, by rule name, as Hyprland would hold them after the commands. */
function namedRules(
  commands: ReadonlyArray<Pick<KeywordCommand, "keyword" | "value">>,
): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();
  for (const { keyword, value } of commands) {
    const named = NAMED_KEY.exec(keyword);
    expect(named, keyword).not.toBeNull();
    const fields = rules.get(named![1]!) ?? {};
    fields[named![2]!] = value;
    rules.set(named![1]!, fields);
  }
  return rules;
}

/** The `move` of the rule that selects the widget on monitor `name`. */
function moveOnMonitor(
  commands: ReadonlyArray<Pick<KeywordCommand, "keyword" | "value">>,
  name: string,
): string | undefined {
  const rule = [...namedRules(commands).values()].find(
    (fields) =>
      fields["match:title"] === TITLE_PATTERN && fields["match:workspace"] === `m[${name}]`,
  );
  return rule?.move;
}

describe("search unification phase 5 rework: placement per monitor", () => {
  it("search unification phase 5 P1-1: each monitor's rule keeps the margin above that monitor's own reserved bottom", async () => {
    const { rules, execute, windowruleValues } = makeRules(HYPRLAND, {
      monitors: [
        monitor({ id: 0, name: "HDMI-A-1", focused: false, reserved: [0, 0, 0, 80] }),
        monitor({ id: 1, name: "eDP-1", focused: true, reserved: [0, 40, 0, 30] }),
      ],
    });
    await rules.apply();
    expect(moveOnMonitor(windowruleValues(), "HDMI-A-1")).toBe(moveTo(BOTTOM_MARGIN + 80));
    expect(moveOnMonitor(windowruleValues(), "eDP-1")).toBe(moveTo(BOTTOM_MARGIN + 30));
    // One monitor read, one provider read and one batch, however many monitors there are.
    expect(execute.mock.calls.map(([, args]) => (args[0] === "-j" ? args[1] : args[0]))).toEqual([
      "monitors",
      "status",
      "--batch",
    ]);
  });
});

/**
 * A Hyprland 0.57.1 with a Lua config, as the laptop runs since 2026-11-08: `keyword` and
 * `--batch` print `unknown request` and exit 0, `eval` prints `ok`, or `error: …` with exit 7.
 */
function makeLuaRules(evalResult: () => string = () => "ok") {
  const execute = vi.fn(async (_file: string, args: ReadonlyArray<string>) => {
    if (args[0] === "-j" && args[1] === "status")
      return { stdout: JSON.stringify({ configProvider: "lua", backend: "drm" }) };
    if (args[0] === "-j" && args[1] === "monitors")
      return { stdout: JSON.stringify([monitor({ reserved: [0, 36, 0, 0] })]) };
    if (args[0] === "eval") {
      const result = evalResult();
      if (result.startsWith("error:"))
        throw Object.assign(new Error("Command failed"), { code: 7, stdout: result });
      return { stdout: result };
    }
    return { stdout: "unknown request" };
  });
  const onError = vi.fn();
  const rules = createHyprlandWidgetRules({ env: HYPRLAND, execute, onError });
  const evals = () =>
    execute.mock.calls.filter(([, args]) => args[0] === "eval").map(([, args]) => args[1]!);
  return { rules, execute, onError, evals };
}

describe("dictation widget rules under a Lua config", () => {
  it("sends the whole rule through hyprctl eval, and no keyword Hyprland would reject", async () => {
    const { rules, execute, onError, evals } = makeLuaRules();
    await rules.apply();
    expect(onError).not.toHaveBeenCalled();
    expect(
      execute.mock.calls.some(([, args]) => args[0] === "--batch" || args[0] === "keyword"),
    ).toBe(false);
    expect(evals()).toHaveLength(1);
    const lua = evals()[0]!;
    expect(lua).toContain(`match = { title = "${TITLE_PATTERN}" }`);
    for (const effect of [
      "float = true",
      "pin = true",
      "no_initial_focus = true",
      "no_focus = true",
      "border_size = 0",
      "rounding = 0",
      "no_shadow = true",
      "no_blur = true",
      'size = "440 64"',
      `move = "${moveTo(BOTTOM_MARGIN)}"`,
    ])
      expect(lua).toContain(effect);
    expect(lua).toContain(`match = { title = "${TITLE_PATTERN}", workspace = "m[eDP-1]" }`);
  });

  it("disables the rules a previous apply left before adding its own", async () => {
    const { rules, evals } = makeLuaRules();
    await rules.apply();
    await rules.reapply();
    expect(evals()).toHaveLength(2);
    for (const lua of evals()) {
      const release = lua.indexOf("pcall(handle.set_enabled, handle, false)");
      expect(release).toBeGreaterThanOrEqual(0);
      expect(release).toBeLessThan(lua.indexOf("hl.window_rule("));
    }
  });

  it("logs a rule Hyprland refused, and sends it again on the next apply", async () => {
    let result = "error: hl.window_rule: unknown field 'no_blur'";
    const { rules, onError, evals } = makeLuaRules(() => result);
    await rules.apply();
    expect(onError).toHaveBeenCalledWith(new Error(result));
    result = "ok";
    await rules.apply();
    expect(evals()).toHaveLength(2);
  });
});
