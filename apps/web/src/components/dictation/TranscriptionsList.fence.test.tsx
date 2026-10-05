// @vitest-environment happy-dom
/**
 * Entry point: AppRoot → CommandPalette, through `threadSearchPicker.testMount.tsx`.
 * The user opens the palette with Ctrl+O and picks the Transcriptions action;
 * the list it opens is the real `TranscriptionsList`. The fixture replaces data
 * sources only: environments, entities, settings, the RPC command boundary, and
 * the dictation jobs read (`useDictationJobs` in `~/state/dictation`).
 *
 * Phase 2 of the STT redesign, criteria 5 and 6. The list is found by
 * `data-testid="transcriptions-list"` and its rows are its `li` elements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const dictationFixture = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
  environmentIds: [] as Array<string | null>,
  /** `undefined` keeps the fixture's primary environment; `null` removes it, as in the hosted app. */
  primaryEnvironmentId: undefined as string | null | undefined,
}));

vi.mock("~/state/entities", async (original) =>
  (await import("../threads/threadSearchPicker.testFixtures")).mockEntities(await original()),
);
vi.mock("~/state/environments", async (original) => {
  const mocked = (await import("../threads/threadSearchPicker.testFixtures")).mockEnvironments(
    await original<typeof import("~/state/environments")>(),
  );
  return {
    ...mocked,
    usePrimaryEnvironmentId: () =>
      dictationFixture.primaryEnvironmentId === undefined
        ? mocked.usePrimaryEnvironmentId()
        : dictationFixture.primaryEnvironmentId,
    usePrimaryEnvironment: () =>
      dictationFixture.primaryEnvironmentId === null ? null : mocked.usePrimaryEnvironment(),
  };
});
vi.mock("~/state/queries", async (original) =>
  (await import("../threads/threadSearchPicker.testFixtures")).mockQueries(await original()),
);
vi.mock("~/state/orchestration", async (original) =>
  (await import("../threads/threadSearchPicker.testFixtures")).mockOrchestration(await original()),
);
vi.mock("~/state/use-atom-command", async () =>
  (await import("../threads/threadSearchPicker.testFixtures")).mockUseAtomCommand(),
);
vi.mock("~/hooks/useSettings", async (original) =>
  (await import("../threads/threadSearchPicker.testFixtures")).mockSettings(await original()),
);
vi.mock("~/state/dictation", async (original) => ({
  ...(await original<typeof import("~/state/dictation")>()),
  useDictationJobs: (environmentId: string | null) => {
    dictationFixture.environmentIds.push(environmentId);
    return { jobs: dictationFixture.jobs, loaded: true };
  },
}));

import { EnvironmentId } from "@t3tools/contracts";

import {
  LAPTOP_ENVIRONMENT_ID,
  resetThreadSearchFixture,
  threadSearchFixture,
  VIGILIA_ENVIRONMENT_ID,
} from "../threads/threadSearchPicker.testFixtures";
import {
  buttonIn,
  click,
  mountApp,
  openCommandPalette,
  optionRows,
  paletteElement,
  settle,
  type MountedApp,
} from "../threads/threadSearchPicker.testMount";
import { closeTranscriptionsList, resolveTranscriptionsEnvironment } from "./TranscriptionsList";

const HOUR_MS = 60 * 60 * 1000;
const RETRY_COMMAND_LABEL = "environment-data:dictation:retry";

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function dictationJobs() {
  return [
    {
      id: "job-recent-completed",
      target: null,
      mode: "inject",
      status: "completed",
      text: "Ship the dictation settings page\nand the second line stays hidden",
      durationMs: 4_000,
      createdAt: hoursAgo(1),
      completedAt: hoursAgo(1),
    },
    {
      id: "job-recent-failed",
      target: null,
      mode: "clipboard",
      status: "failed",
      failure: "OpenAI rejected the key",
      durationMs: 2_000,
      createdAt: hoursAgo(2),
      completedAt: hoursAgo(2),
    },
    {
      id: "job-expired-completed",
      target: null,
      mode: "submit",
      status: "completed",
      text: "Ancient transcript from yesterday",
      durationMs: 3_000,
      createdAt: hoursAgo(25),
      completedAt: hoursAgo(25),
    },
  ];
}

let app: MountedApp | undefined;

beforeEach(() => {
  resetThreadSearchFixture();
  dictationFixture.jobs = dictationJobs();
  dictationFixture.environmentIds = [];
  dictationFixture.primaryEnvironmentId = undefined;
});

afterEach(async () => {
  // The open request outlives the mount, as it outlives the palette in the app.
  closeTranscriptionsList();
  await app?.unmount();
  app = undefined;
  vi.unstubAllGlobals();
});

function paletteRowTitled(title: string): HTMLElement {
  const row = optionRows().find((candidate) => candidate.textContent?.trim().startsWith(title));
  expect(
    row,
    `Expected a palette row titled ${title}; rows: ${optionRows().map((r) => r.textContent)}`,
  ).toBeDefined();
  return row!;
}

function transcriptionsList(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="transcriptions-list"]');
}

function transcriptionRows(): HTMLElement[] {
  return [...(transcriptionsList()?.querySelectorAll<HTMLElement>("li") ?? [])];
}

async function openTranscriptionsFromPalette(): Promise<void> {
  await openCommandPalette();
  await click(paletteRowTitled("Transcriptions"));
}

async function openTranscriptions(): Promise<HTMLElement> {
  app = await mountApp();
  await openTranscriptionsFromPalette();
  const list = transcriptionsList();
  expect(
    list,
    `Expected the transcriptions list; body: ${document.body.textContent}`,
  ).not.toBeNull();
  return list!;
}

describe("transcriptions palette entry (criterion 6)", () => {
  it("transcriptions palette: the command palette lists a Transcriptions action that opens the list", async () => {
    await openTranscriptions();
    expect(paletteElement()).toBeNull();
  });
});

describe("transcriptions list (criterion 5)", () => {
  it("transcriptions list: shows the recent completed and failed jobs, newest first, and hides jobs older than 24 hours", async () => {
    const list = await openTranscriptions();
    const rows = transcriptionRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Ship the dictation settings page");
    expect(rows[0]!.textContent).not.toContain("the second line stays hidden");
    expect(rows[1]!.textContent).toMatch(/fail/i);
    expect(list.textContent).not.toContain("Ancient transcript from yesterday");
    expect(dictationFixture.environmentIds).toContain(LAPTOP_ENVIRONMENT_ID);
  });

  it("transcriptions list: Retry appears only on the failed job", async () => {
    await openTranscriptions();
    const [completed, failed] = transcriptionRows();
    buttonIn(failed!, /retry/i);
    expect(
      [...completed!.querySelectorAll("button")].some((button) =>
        /retry/i.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
      ),
    ).toBe(false);
  });

  it("transcriptions list: Copy writes the full transcript with the async clipboard", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await openTranscriptions();
    await click(buttonIn(transcriptionRows()[0]!, /copy/i));
    expect(writeText).toHaveBeenCalledWith(
      "Ship the dictation settings page\nand the second line stays hidden",
    );
  });

  it("transcriptions list: Copy falls back to a hidden textarea when the async clipboard is missing", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    const copied: string[] = [];
    const execCommand = vi.fn((command: string) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-hidden="true"]');
      if (command === "copy" && textarea) copied.push(textarea.value);
      return true;
    });
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    try {
      await openTranscriptions();
      await click(buttonIn(transcriptionRows()[0]!, /copy/i));
      expect(copied).toEqual([
        "Ship the dictation settings page\nand the second line stays hidden",
      ]);
    } finally {
      Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("transcriptions list: Retry dispatches the retry command for that job on its environment", async () => {
    await openTranscriptions();
    await click(buttonIn(transcriptionRows()[1]!, /retry/i));
    expect(threadSearchFixture.commandCalls).toContainEqual({
      label: RETRY_COMMAND_LABEL,
      value: { environmentId: LAPTOP_ENVIRONMENT_ID, input: { jobId: "job-recent-failed" } },
    });
  });
});

describe("transcriptions environment (review P1-1)", () => {
  it("transcriptions palette: from a thread on a non-primary environment the list shows and retries that environment's jobs", async () => {
    app = await mountApp();
    await app.router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: VIGILIA_ENVIRONMENT_ID, threadId: "thread-hosts-dock" },
    });
    await settle();
    await openTranscriptionsFromPalette();

    expect(transcriptionsList()).not.toBeNull();
    expect(dictationFixture.environmentIds.at(-1)).toBe(VIGILIA_ENVIRONMENT_ID);
    await click(buttonIn(transcriptionRows()[1]!, /retry/i));
    expect(threadSearchFixture.commandCalls).toContainEqual({
      label: RETRY_COMMAND_LABEL,
      value: { environmentId: VIGILIA_ENVIRONMENT_ID, input: { jobId: "job-recent-failed" } },
    });
  });

  it("transcriptions palette: with no primary and several connected environments the user picks one first", async () => {
    dictationFixture.primaryEnvironmentId = null;
    app = await mountApp();
    await openTranscriptionsFromPalette();

    expect(transcriptionsList()).toBeNull();
    expect(dictationFixture.environmentIds).toEqual([]);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await click(buttonIn(dialog, /^Vigilia$/));

    expect(transcriptionsList()).not.toBeNull();
    expect(dictationFixture.environmentIds.at(-1)).toBe(VIGILIA_ENVIRONMENT_ID);
  });
});

describe("transcriptions environment resolution", () => {
  const laptop = { environmentId: EnvironmentId.make("resolve-laptop"), label: "Laptop" };
  const vigilia = { environmentId: EnvironmentId.make("resolve-vigilia"), label: "Vigilia" };

  it("transcriptions environment: the opener's environment wins over the primary one", () => {
    expect(
      resolveTranscriptionsEnvironment({
        requested: vigilia.environmentId,
        primary: laptop.environmentId,
        connected: [laptop, vigilia],
      }),
    ).toEqual({ kind: "environment", environmentId: vigilia.environmentId });
  });

  it("transcriptions environment: without context the primary one is used, then the only connected one", () => {
    expect(
      resolveTranscriptionsEnvironment({
        requested: null,
        primary: laptop.environmentId,
        connected: [laptop, vigilia],
      }),
    ).toEqual({ kind: "environment", environmentId: laptop.environmentId });
    expect(
      resolveTranscriptionsEnvironment({ requested: null, primary: null, connected: [vigilia] }),
    ).toEqual({ kind: "environment", environmentId: vigilia.environmentId });
  });

  it("transcriptions environment: no context and no connected environment resolves to none", () => {
    expect(
      resolveTranscriptionsEnvironment({ requested: null, primary: null, connected: [] }),
    ).toEqual({ kind: "none" });
  });
});
