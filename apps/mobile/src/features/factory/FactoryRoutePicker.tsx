import type { ServerProvider } from "@t3tools/contracts";
import {
  changeFactoryRouteBudget,
  changeFactoryRouteEffort,
  changeFactoryRouteModel,
  describeFactoryRoute,
  FACTORY_HARNESS_LABELS,
  FACTORY_ROUTE_ROLE_LABELS,
  FACTORY_ROUTE_ROLES,
  factoryRouteEffortOptions,
  factoryRouteModelOptions,
  factoryRouteSlotHarness,
  parseFactoryBudgetUsd,
  type FactoryRouteRole,
  type FactoryRoutes,
  type FactoryRouteSlots,
} from "@t3tools/client-runtime/factory/routes";
import {
  approvedWithoutRoutesText,
  type FactoryApprovalRoutesBlock,
} from "@t3tools/client-runtime/factory/plan-approval";
import { memo, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";

interface RouteChoice {
  readonly key: string;
  readonly label: string;
  readonly selected: boolean;
  readonly onChoose: () => void;
}

interface RouteChoiceGroup {
  readonly title: string | null;
  readonly choices: ReadonlyArray<RouteChoice>;
}

/** A bottom sheet of models or levels, as the thread settings sheet lists models. */
function RouteChoiceSheet(props: {
  readonly title: string;
  readonly groups: ReadonlyArray<RouteChoiceGroup>;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="slide"
      presentationStyle={Platform.OS === "android" ? "overFullScreen" : "pageSheet"}
      transparent={Platform.OS === "android"}
      onRequestClose={props.onClose}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          backgroundColor: Platform.OS === "android" ? "#00000066" : undefined,
        }}
      >
        {Platform.OS === "android" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss the list"
            onPress={props.onClose}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          />
        ) : null}
        <View className="max-h-[70%] overflow-hidden rounded-t-3xl bg-sheet-solid">
          <Text className="border-b border-border px-4 pb-2 pt-4 font-t3-bold text-base text-foreground">
            {props.title}
          </Text>
          <ScrollView contentContainerStyle={{ paddingBottom: Math.max(16, insets.bottom) }}>
            {props.groups.map((group) => (
              <View key={group.title ?? "levels"} className="pt-2">
                {group.title === null ? null : (
                  <Text className="px-4 pb-1 font-t3-medium text-xs text-foreground-muted">
                    {group.title}
                  </Text>
                )}
                {group.choices.map((choice) => (
                  <Pressable
                    key={choice.key}
                    accessibilityRole="button"
                    accessibilityState={{ selected: choice.selected }}
                    onPress={choice.onChoose}
                    className="min-h-11 justify-center px-4 active:opacity-65"
                  >
                    <Text
                      className={
                        choice.selected
                          ? "font-t3-bold text-sm text-foreground"
                          : "text-sm text-foreground"
                      }
                    >
                      {choice.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function BudgetField(props: {
  readonly budgetUsd: number | undefined;
  readonly onChange: (budgetUsd: number) => void;
}) {
  // The typed text, so an empty field stays empty while Approve is disabled.
  const [text, setText] = useState(() =>
    props.budgetUsd === undefined || Number.isNaN(props.budgetUsd) ? "" : String(props.budgetUsd),
  );
  return (
    <View className="min-h-9 flex-row items-center gap-1 rounded-lg border border-border bg-subtle px-3">
      <Text className="text-sm text-foreground-muted">$</Text>
      <TextInput
        accessibilityLabel="Implementer budget"
        keyboardType="decimal-pad"
        className="min-w-10 text-sm text-foreground"
        value={text}
        onChangeText={(next: string) => {
          setText(next);
          props.onChange(parseFactoryBudgetUsd(next));
        }}
      />
    </View>
  );
}

type OpenSheet = { readonly role: FactoryRouteRole; readonly kind: "model" | "level" } | null;

const CONTROL_CLASS =
  "min-h-9 justify-center rounded-lg border border-border bg-subtle px-3 active:opacity-65";

function FactoryRouteRow(props: {
  readonly role: FactoryRouteRole;
  readonly slots: FactoryRouteSlots;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly openSheet: OpenSheet;
  readonly onOpenSheet: (sheet: OpenSheet) => void;
  readonly onChange: (slots: FactoryRouteSlots) => void;
}) {
  const { role, slots, providers, onChange, onOpenSheet } = props;
  const label = FACTORY_ROUTE_ROLE_LABELS[role];
  const slot = slots[role];
  const route = slot.status === "ready" ? slot.route : null;
  const modelOptions = factoryRouteModelOptions(
    providers,
    role,
    factoryRouteSlotHarness(slots.implementer),
  );
  const levels = route === null ? [] : factoryRouteEffortOptions(providers, route);
  const described = route === null ? null : describeFactoryRoute(providers, route);
  const sheet = props.openSheet?.role === role ? props.openSheet.kind : null;
  const close = () => onOpenSheet(null);

  const modelGroups = (["claude", "codex"] as const).flatMap((harness) => {
    const choices = modelOptions
      .filter((option) => option.harness === harness)
      .map((option) => ({
        key: option.model.slug,
        label: option.model.name,
        selected: route?.harness === harness && route.model === option.model.slug,
        onChoose: () => {
          onChange(
            changeFactoryRouteModel(slots, providers, role, {
              harness,
              model: option.model.slug,
            }),
          );
          close();
        },
      }));
    return choices.length === 0 ? [] : [{ title: FACTORY_HARNESS_LABELS[harness], choices }];
  });
  const levelGroups = [
    {
      title: null,
      choices: levels.map((level) => ({
        key: level.id,
        label: level.label,
        selected: route?.effort === level.id,
        onChoose: () => {
          onChange(changeFactoryRouteEffort(slots, role, level.id));
          close();
        },
      })),
    },
  ];

  return (
    <View className="gap-1.5">
      <Text className="font-t3-medium text-xs text-foreground-muted">{label}</Text>
      <View className="flex-row flex-wrap gap-2">
        {modelGroups.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} model`}
            onPress={() => onOpenSheet({ role, kind: "model" })}
            className={`${CONTROL_CLASS} flex-1`}
          >
            <Text className="text-sm text-foreground" numberOfLines={1}>
              {described?.model ?? "Choose a model"}
            </Text>
          </Pressable>
        ) : null}
        {described !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${label} reasoning`}
            onPress={() => onOpenSheet({ role, kind: "level" })}
            className={CONTROL_CLASS}
          >
            <Text className="text-sm text-foreground">{described.effort}</Text>
          </Pressable>
        ) : null}
        {route !== null && role === "implementer" && route.harness === "claude" ? (
          // Keyed on the harness: switching back to Claude restores the default budget.
          <BudgetField
            key={route.harness}
            budgetUsd={route.budgetUsd}
            onChange={(budgetUsd) => onChange(changeFactoryRouteBudget(slots, budgetUsd))}
          />
        ) : null}
      </View>
      {slot.status === "unavailable" ? (
        <Text className="text-xs text-foreground-muted">Unavailable: {slot.reason}.</Text>
      ) : null}
      {sheet === "model" ? (
        <RouteChoiceSheet title={`${label} model`} groups={modelGroups} onClose={close} />
      ) : null}
      {sheet === "level" ? (
        <RouteChoiceSheet title={`${label} reasoning`} groups={levelGroups} onClose={close} />
      ) : null}
    </View>
  );
}

/** The three editable route rows at the foot of a plan card. */
export const FactoryRoutePicker = memo(function FactoryRoutePicker(props: {
  readonly slots: FactoryRouteSlots;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (slots: FactoryRouteSlots) => void;
}) {
  // One list at a time, whichever row opened it.
  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);
  return (
    <View className="gap-3">
      {FACTORY_ROUTE_ROLES.map((role) => (
        <FactoryRouteRow
          key={role}
          role={role}
          slots={props.slots}
          providers={props.providers}
          openSheet={openSheet}
          onOpenSheet={setOpenSheet}
          onChange={props.onChange}
        />
      ))}
    </View>
  );
});

/** The routes an approval carried, read-only. */
export const FactoryApprovedRoutes = memo(function FactoryApprovedRoutes(props: {
  readonly routes: FactoryRoutes | null;
  readonly routesBlock: FactoryApprovalRoutesBlock;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const { routes } = props;
  if (routes === null) {
    return (
      <Text className="text-sm text-foreground-muted">
        {approvedWithoutRoutesText(props.routesBlock)}
      </Text>
    );
  }
  return (
    <View className="gap-1">
      {FACTORY_ROUTE_ROLES.map((role) => {
        const route = routes[role];
        const described = describeFactoryRoute(props.providers, route);
        return (
          <Text key={role} className="text-sm text-foreground" numberOfLines={2}>
            {`${FACTORY_ROUTE_ROLE_LABELS[role]}: ${described.model} · ${described.effort}${
              route.budgetUsd === undefined ? "" : ` · $${route.budgetUsd}`
            }`}
          </Text>
        );
      })}
    </View>
  );
});
