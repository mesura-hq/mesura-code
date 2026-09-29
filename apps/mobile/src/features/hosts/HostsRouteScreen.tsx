import { useIsFocused, useNavigation } from "@react-navigation/native";
import { projectHostStats } from "@t3tools/client-runtime/host-stats";
import {
  HOST_STATS_AGE_REFRESH_MS,
  createHostStatsAgeClock,
  hostFleetSummary,
  type HostStatsAgeClock,
} from "@t3tools/client-runtime/host-stats/view";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState, Platform, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useHostStatsSources, useResubscribeHostStats } from "../../state/hostStats";
import { HostSection } from "./HostSection";
import { HOST_STATS_REFRESH_SPINNER_MS } from "./hostsScreen.logic";

function subscribeToAppState(onChange: () => void): () => void {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
}

/**
 * Whether the app is in the foreground. Only `background` counts as away:
 * React Native reports `unknown` before its first event, and iOS passes through
 * `inactive` for a pulled-down control centre.
 */
function useAppIsActive(): boolean {
  return useSyncExternalStore(subscribeToAppState, () => AppState.currentState !== "background");
}

/**
 * The time the screen projects with. It moves at most every 15 s and only
 * while the screen is seen, so ages advance without a repaint every second and
 * a hidden screen schedules nothing. Mirror of the web dock's clock hook over
 * the shared `createHostStatsAgeClock`.
 */
function useHostStatsNow(visible: boolean): number {
  const [nowLocal, setNowLocal] = useState(() => Date.now());
  const clockRef = useRef<HostStatsAgeClock | null>(null);
  if (clockRef.current === null) {
    clockRef.current = createHostStatsAgeClock({
      intervalMs: HOST_STATS_AGE_REFRESH_MS,
      now: () => Date.now(),
      schedule: (callback, delayMs) => setTimeout(callback, delayMs),
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onTick: setNowLocal,
    });
  }
  useEffect(() => {
    clockRef.current?.setOpen(visible);
  }, [visible]);
  useEffect(() => () => clockRef.current?.dispose(), []);
  return nowLocal;
}

/**
 * Pull to refresh: resubscribes every connected environment, then ends the
 * spinner in a later commit, since Android's RefreshControl keeps spinning
 * until it sees true, then false — even when nothing was connected.
 */
function useHostsRefresh() {
  const resubscribe = useResubscribeHostStats();
  const [refreshing, setRefreshing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  const refresh = (presentations: Parameters<typeof resubscribe>[0]) => {
    setRefreshing(true);
    try {
      resubscribe(presentations);
    } finally {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setRefreshing(false);
      }, HOST_STATS_REFRESH_SPINNER_MS);
    }
  };
  return { refreshing, refresh };
}

/**
 * Settings → Hosts: every connected machine's health, as the web Hosts dock
 * shows it. Subscriptions live only while the screen is focused and the app
 * is in the foreground; while hidden it keeps the last readings, and ages
 * them on return until fresh data arrives.
 */
export function HostsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const appActive = useAppIsActive();
  const visible = focused && appActive;
  const sources = useHostStatsSources(visible);
  const nowLocal = useHostStatsNow(visible);
  const hosts = useMemo(() => projectHostStats({ ...sources, nowLocal }), [sources, nowLocal]);
  const { refreshing, refresh } = useHostsRefresh();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Hosts" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => refresh(sources.presentations)}
          />
        }
      >
        {hosts.length === 0 ? (
          <Text className="py-8 text-center text-base text-foreground-muted">
            No hosts connected
          </Text>
        ) : (
          <>
            <Text className="px-2 font-mono text-xs text-foreground-muted">
              {hostFleetSummary(hosts)}
            </Text>
            {hosts.map((host) => (
              <HostSection host={host} key={host.environmentId} />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
