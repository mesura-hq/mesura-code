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
  type FactoryHarness,
  type FactoryRouteRole,
  type FactoryRoutes,
  type FactoryRouteSlots,
} from "@t3tools/client-runtime/factory/routes";
import {
  approvedWithoutRoutesText,
  type FactoryApprovalRoutesBlock,
} from "@t3tools/client-runtime/factory/plan-approval";
import { memo, useState } from "react";

import { Input } from "../components/ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const modelValue = (harness: FactoryHarness, slug: string) => `${harness}:${slug}`;

function parseModelValue(value: string): { harness: FactoryHarness; model: string } | null {
  const separator = value.indexOf(":");
  const harness = value.slice(0, separator);
  if (harness !== "claude" && harness !== "codex") return null;
  return { harness, model: value.slice(separator + 1) };
}

function BudgetInput(props: {
  readonly budgetUsd: number | undefined;
  readonly onChange: (budgetUsd: number) => void;
}) {
  // The typed text, so an empty or half-typed field stays as typed while the
  // routes hold `NaN` and keep Approve disabled.
  const [text, setText] = useState(() =>
    props.budgetUsd === undefined || Number.isNaN(props.budgetUsd) ? "" : String(props.budgetUsd),
  );
  return (
    <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      $
      <Input
        aria-label="Implementer budget"
        className="w-16"
        inputMode="decimal"
        min={1}
        nativeInput
        size="sm"
        type="number"
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
          props.onChange(parseFactoryBudgetUsd(event.currentTarget.value));
        }}
      />
    </label>
  );
}

function FactoryRouteRow(props: {
  readonly role: FactoryRouteRole;
  readonly slots: FactoryRouteSlots;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (slots: FactoryRouteSlots) => void;
}) {
  const { role, slots, providers, onChange } = props;
  const label = FACTORY_ROUTE_ROLE_LABELS[role];
  const slot = slots[role];
  const route = slot.status === "ready" ? slot.route : null;
  const modelOptions = factoryRouteModelOptions(
    providers,
    role,
    factoryRouteSlotHarness(slots.implementer),
  );
  const groups = (["claude", "codex"] as const).flatMap((harness) => {
    const models = modelOptions.filter((option) => option.harness === harness);
    return models.length === 0 ? [] : [{ harness, models }];
  });
  const levels = route === null ? [] : factoryRouteEffortOptions(providers, route);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-24 shrink-0 text-xs font-medium text-foreground">{label}</span>
        {groups.length > 0 ? (
          <Select
            value={route === null ? null : modelValue(route.harness, route.model)}
            items={modelOptions.map((option) => ({
              value: modelValue(option.harness, option.model.slug),
              label: option.model.name,
            }))}
            onValueChange={(value) => {
              const selection = typeof value === "string" ? parseModelValue(value) : null;
              if (selection !== null) {
                onChange(changeFactoryRouteModel(slots, providers, role, selection));
              }
            }}
          >
            <SelectTrigger aria-label={`${label} model`} className="min-w-40 flex-1" size="sm">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {groups.map((group) => (
                <SelectGroup key={group.harness}>
                  <SelectGroupLabel>{FACTORY_HARNESS_LABELS[group.harness]}</SelectGroupLabel>
                  {group.models.map((option) => (
                    <SelectItem
                      key={option.model.slug}
                      value={modelValue(option.harness, option.model.slug)}
                    >
                      {option.model.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {route !== null ? (
          <Select
            value={route.effort}
            items={levels.map((level) => ({ value: level.id, label: level.label }))}
            onValueChange={(value) => {
              if (typeof value === "string") onChange(changeFactoryRouteEffort(slots, role, value));
            }}
          >
            <SelectTrigger aria-label={`${label} reasoning`} className="w-32 min-w-0" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {levels.map((level) => (
                <SelectItem key={level.id} value={level.id}>
                  {level.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
        {route !== null && role === "implementer" && route.harness === "claude" ? (
          // Keyed on the harness: switching back to Claude restores the default budget.
          <BudgetInput
            key={route.harness}
            budgetUsd={route.budgetUsd}
            onChange={(budgetUsd) => onChange(changeFactoryRouteBudget(slots, budgetUsd))}
          />
        ) : null}
      </div>
      {slot.status === "unavailable" ? (
        <p className="pl-26 text-xs text-muted-foreground">Unavailable: {slot.reason}.</p>
      ) : null}
    </div>
  );
}

/** The three editable route rows at the foot of a plan card. */
export const FactoryRoutePicker = memo(function FactoryRoutePicker(props: {
  readonly slots: FactoryRouteSlots;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (slots: FactoryRouteSlots) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {FACTORY_ROUTE_ROLES.map((role) => (
        <FactoryRouteRow
          key={role}
          role={role}
          slots={props.slots}
          providers={props.providers}
          onChange={props.onChange}
        />
      ))}
    </div>
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
      <p className="text-xs text-muted-foreground">
        {approvedWithoutRoutesText(props.routesBlock)}
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-1 text-xs">
      {FACTORY_ROUTE_ROLES.map((role) => {
        const route = routes[role];
        const described = describeFactoryRoute(props.providers, route);
        return (
          <div key={role} className="contents">
            <dt className="font-medium text-foreground">{FACTORY_ROUTE_ROLE_LABELS[role]}</dt>
            <dd className="text-foreground/80">
              {described.model} · {described.effort}
              {route.budgetUsd === undefined ? null : ` · $${route.budgetUsd}`}
            </dd>
          </div>
        );
      })}
    </dl>
  );
});
