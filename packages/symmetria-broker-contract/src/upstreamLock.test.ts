import type {
  ProviderRuntimeEvent,
  RuntimeErrorClass,
  RuntimeSessionExitKind,
  RuntimeSessionState,
  RuntimeThreadState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

// Mesura: upstream no longer exports the vocabulary as its own type.
type ProviderRuntimeEventType = ProviderRuntimeEvent["type"];

import {
  BORROWED_RUNTIME_VOCABULARIES,
  providerRuntimeEventTypeLock,
  runtimeErrorClassLock,
  runtimeSessionExitKindLock,
  runtimeSessionStateLock,
  runtimeThreadStateLock,
  type MutuallyAssignable,
  type ProviderRuntimeEventTypeLiteral,
  type RuntimeErrorClassLiteral,
  type RuntimeSessionExitKindLiteral,
  type RuntimeSessionStateLiteral,
  type RuntimeThreadStateLiteral,
} from "./upstreamLock.ts";

/**
 * Each pair drops one literal from a borrowed vocabulary (a stale copy) and asserts the lock
 * refuses it. An unused `@ts-expect-error` is itself an error, so the typecheck stays green
 * only while each lock fires.
 */

type StaleSessionState = Exclude<RuntimeSessionStateLiteral, "waiting">;
type StaleSessionStateLock = MutuallyAssignable<StaleSessionState, RuntimeSessionState>;
// @ts-expect-error a stale RuntimeSessionState copy must not satisfy the lock
const staleSessionStateLock: StaleSessionStateLock = true;

type StaleThreadState = Exclude<RuntimeThreadStateLiteral, "compacted">;
type StaleThreadStateLock = MutuallyAssignable<StaleThreadState, RuntimeThreadState>;
// @ts-expect-error a stale RuntimeThreadState copy must not satisfy the lock
const staleThreadStateLock: StaleThreadStateLock = true;

type StaleSessionExitKind = Exclude<RuntimeSessionExitKindLiteral, "graceful">;
type StaleSessionExitKindLock = MutuallyAssignable<StaleSessionExitKind, RuntimeSessionExitKind>;
// @ts-expect-error a stale RuntimeSessionExitKind copy must not satisfy the lock
const staleSessionExitKindLock: StaleSessionExitKindLock = true;

type StaleErrorClass = Exclude<RuntimeErrorClassLiteral, "permission_error">;
type StaleErrorClassLock = MutuallyAssignable<StaleErrorClass, RuntimeErrorClass>;
// @ts-expect-error a stale RuntimeErrorClass copy must not satisfy the lock
const staleErrorClassLock: StaleErrorClassLock = true;

type StaleEventType = Exclude<ProviderRuntimeEventTypeLiteral, "runtime.error">;
type StaleEventTypeLock = MutuallyAssignable<StaleEventType, ProviderRuntimeEventType>;
// @ts-expect-error a stale ProviderRuntimeEventType copy must not satisfy the lock
const staleEventTypeLock: StaleEventTypeLock = true;

const staleLocks = {
  RuntimeSessionState: staleSessionStateLock,
  RuntimeThreadState: staleThreadStateLock,
  RuntimeSessionExitKind: staleSessionExitKindLock,
  RuntimeErrorClass: staleErrorClassLock,
  ProviderRuntimeEventType: staleEventTypeLock,
};

const liveLocks = {
  RuntimeSessionState: runtimeSessionStateLock,
  RuntimeThreadState: runtimeThreadStateLock,
  RuntimeSessionExitKind: runtimeSessionExitKindLock,
  RuntimeErrorClass: runtimeErrorClassLock,
  ProviderRuntimeEventType: providerRuntimeEventTypeLock,
};

describe("borrowed runtime vocabularies", () => {
  it("locks every vocabulary the projection borrows", () => {
    expect(Object.keys(liveLocks).sort()).toEqual(
      Object.keys(BORROWED_RUNTIME_VOCABULARIES).sort(),
    );
    for (const [name, lock] of Object.entries(liveLocks)) {
      expect(lock, `${name} lock did not hold`).toBe(true);
    }
  });

  it("pairs every lock with a stale-copy proof", () => {
    expect(Object.keys(staleLocks).sort()).toEqual(Object.keys(liveLocks).sort());
  });

  it("keeps every vocabulary free of duplicate and empty literals", () => {
    for (const [name, literals] of Object.entries(BORROWED_RUNTIME_VOCABULARIES)) {
      expect(literals.length, `${name} is empty`).toBeGreaterThan(0);
      expect(new Set(literals).size, `${name} repeats a literal`).toBe(literals.length);
      for (const literal of literals) {
        expect(literal.length, `${name} carries an empty literal`).toBeGreaterThan(0);
      }
    }
  });
});
