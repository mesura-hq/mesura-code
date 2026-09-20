import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled = true) => (enabled ? stageArtworkState.variant : null),
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

// Two traps in one assertion: the markup also holds the stop and Previous
// buttons, and every button's class list contains `disabled:opacity-64`. So
// read the submit button's own tag, and look for the ATTRIBUTE.
function isSubmitButtonDisabled(markup: string): boolean {
  const tag = markup.match(/<button[^>]*type="submit"[^>]*>/);
  if (!tag) throw new Error("no submit button rendered");
  return tag[0].includes('disabled=""');
}

function renderPendingSubmit(
  pendingAction: Partial<{
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
    firstUnansweredQuestionIndex: number | null;
  }> = {},
  compact = false,
) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact,
      pendingAction: {
        questionIndex: 2,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
        firstUnansweredQuestionIndex: null,
        ...pendingAction,
      },
      isRunning: true,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderRunningActions(hasSendableContent: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: true,
      showPlanFollowUpPrompt: false,
      promptHasText: hasSendableContent,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderSendButton(sendDisabledReason: string | null = null) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", () => {
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
  });

  it("hides stage artwork when artwork identification is inactive", () => {
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
  });

  it("renders a queue action alongside stop while running with a sendable draft", () => {
    const markup = renderRunningActions(true);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).toContain('aria-label="Queue message"');
    expect(markup).toContain('type="submit"');
  });

  it("keeps stop as the only action while running with an empty composer", () => {
    const markup = renderRunningActions(false);

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Queue message"');
  });

  // The dead end this replaces: on the last question the button read the
  // WHOLE set, so a missing earlier answer left it disabled — and the prompt
  // shows one question at a time, so nothing on screen said which one. The
  // only way out was to cancel the prompt and answer everything again.
  it("sends the user to the missing answer instead of sitting disabled", () => {
    const markup = renderPendingSubmit({ isComplete: false, firstUnansweredQuestionIndex: 0 });

    expect(markup).toContain("Answer question 1");
    expect(markup).toContain('title="Question 1 has no answer yet"');
    expect(isSubmitButtonDisabled(markup)).toBe(false);
  });

  it("shortens that label on a compact composer", () => {
    expect(
      renderPendingSubmit({ isComplete: false, firstUnansweredQuestionIndex: 1 }, true),
    ).toContain("Question 2");
  });

  it("submits normally once every question is answered", () => {
    const markup = renderPendingSubmit();

    expect(markup).toContain("Submit answers");
    expect(isSubmitButtonDisabled(markup)).toBe(false);
  });

  // The question ON SCREEN still governs the button, on the last question as
  // much as on any other.
  it("stays disabled while the question on screen has no answer", () => {
    const markup = renderPendingSubmit({
      canAdvance: false,
      isComplete: false,
      firstUnansweredQuestionIndex: 2,
    });

    expect(isSubmitButtonDisabled(markup)).toBe(true);
    // And it must not offer to take the user to question 3 — that is the
    // question already on screen, and this button cannot move.
    expect(markup).toContain("Submit answers");
    expect(markup).not.toContain("Answer question 3");
  });
});
