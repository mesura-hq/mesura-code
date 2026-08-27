import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/unstable/reactivity";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { resolveMobileThreadSortOrder } from "../../state/thread-order";
import { SettingsSection } from "./components/SettingsSection";
import { THREAD_ORDER_OPTIONS } from "./thread-order-settings";

export function SettingsThreadOrderRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const checkmarkColor = useThemeColor("--color-icon");
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedOrder = resolveMobileThreadSortOrder(
    AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : undefined,
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Thread Order" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Active thread order">
          {THREAD_ORDER_OPTIONS.map((option, index) => (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{
                checked: selectedOrder === option.value,
                disabled: !preferencesReady,
              }}
              disabled={!preferencesReady}
              onPress={() => savePreferences({ threadSortOrder: option.value })}
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
            >
              <Text className="min-w-0 flex-1 text-lg text-foreground">{option.label}</Text>
              {selectedOrder === option.value ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColor={checkmarkColor}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
