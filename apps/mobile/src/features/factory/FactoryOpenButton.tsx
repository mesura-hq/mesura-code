import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";

/** A Factory card's Open: pushes the thread's Factory screen above the feed. */
export function FactoryOpenButton(props: { readonly hint: string; readonly onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open"
      accessibilityHint={props.hint}
      className="min-h-9 items-center justify-center self-start rounded-lg border border-border bg-subtle px-3 active:opacity-65"
      onPress={props.onPress}
    >
      <Text className="font-t3-bold text-xs text-foreground">Open</Text>
    </Pressable>
  );
}
