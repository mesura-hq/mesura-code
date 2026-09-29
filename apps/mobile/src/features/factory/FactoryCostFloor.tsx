import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { FACTORY_TEXT_BY_TONE } from "./factoryTones";

/** The mark beside a dollar figure that leaves out the Codex turns, which report only tokens. */
export function FactoryCostFloor() {
  return (
    <Text
      accessibilityLabel="floor: Codex turns report tokens, not dollars, so the dollar figure is a lower bound"
      className={cn("font-t3-medium text-xs", FACTORY_TEXT_BY_TONE.warning)}
    >
      floor
    </Text>
  );
}
