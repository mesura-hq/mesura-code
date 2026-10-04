import type {
  ApprovalRequestId,
  EnvironmentId,
  ThreadId,
  UserInputQuestion,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { appAtomRegistry } from "../../state/atom-registry";
import { usePendingUserInputDrafts } from "../../state/use-selected-thread-requests";
import { Pressable, View, type TextInput } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  type PendingUserInput,
} from "../../lib/threadActivity";
import { QuestionAttachments } from "./QuestionAttachments";
import { hostHasDictationKey } from "@t3tools/client-runtime/dictation";
import { countPendingDictationSlots } from "@t3tools/shared/dictationSlots";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useServerConfigs } from "../../state/entities";
import { useDictationController } from "../voice-input/useDictationController";
import { ServerDictationPrimaryAction } from "../voice-input/ServerDictationControls";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import {
  ComposerDictationCancelAction,
  ComposerDictationStatus,
} from "../voice-input/ComposerDictationControl";

export interface PendingUserInputCardProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly pendingUserInput: PendingUserInput;
  readonly responding: boolean;
  readonly onInputFocusChange?: ((focused: boolean) => void) | undefined;
  readonly onFocusInput?: ((input: TextInput | null) => void) | undefined;
  readonly onSelectOption: (
    requestId: ApprovalRequestId,
    question: UserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    value: string,
  ) => void;
  readonly onSubmit: (requestId: ApprovalRequestId) => Promise<unknown>;
  readonly onDismiss: (requestId: ApprovalRequestId) => Promise<unknown>;
}

// One target across request cards. Changing it cancels the previous voice controller.
const questionVoiceTargetAtom = Atom.make<{ ownerKey: string; questionId: string } | null>(null);

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const request = props.pendingUserInput;
  const drafts = usePendingUserInputDrafts(props.environmentId, props.threadId, request);
  const answers = useMemo(
    () => buildPendingUserInputAnswers(request.questions, drafts),
    [request.questions, drafts],
  );
  const voiceTarget = useAtomValue(questionVoiceTargetAtom);
  const ownerKey = JSON.stringify([props.environmentId, props.threadId, request.requestId]);
  const focusedQuestionId = voiceTarget?.ownerKey === ownerKey ? voiceTarget.questionId : null;
  const focusedQuestion = request.questions.find(
    (question) => question.id === focusedQuestionId && question.allowCustomAnswer !== false,
  );
  // Mesura: dictation goes through the host. It adds to this answer's note and never replaces
  // its selected options.
  const serverConfig = useServerConfigs().get(props.environmentId) ?? null;
  const voice = useDictationController({
    owner: focusedQuestion
      ? {
          environmentId: props.environmentId,
          draftKey: scopedThreadKey(props.environmentId, props.threadId),
          target: { kind: "thread", environmentId: props.environmentId, threadId: props.threadId },
          question: { requestKey: ownerKey, questionId: focusedQuestion.id },
        }
      : null,
    available: hostHasDictationKey(serverConfig),
    disabled: props.responding,
  });
  const presentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const transcriptionPending = request.questions.some(
    (question) => countPendingDictationSlots(drafts[question.id]?.customAnswer ?? "") > 0,
  );
  const [refusedForTranscription, setRefusedForTranscription] = useState(false);
  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <Text className="font-t3-bold text-lg text-foreground">Fill in the pending answers</Text>
      {props.pendingUserInput.questions.map((question) => {
        const draft = drafts[question.id];
        return (
          <View key={question.id} className="gap-2 pt-1">
            <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-foreground-muted">
              {question.header}
            </Text>
            <Text className="font-sans text-base leading-snug text-foreground">
              {question.question}
            </Text>
            <View className="gap-2">
              {question.options.map((option) => {
                const optionValue = option.value ?? option.label.trim();
                const selected = isPendingUserInputOptionSelected(question, draft, optionValue);
                const description =
                  option.description !== option.label ? option.description : undefined;
                return (
                  <Pressable
                    key={optionValue}
                    accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                    accessibilityState={{ checked: selected }}
                    disabled={props.responding}
                    className={cn(
                      "min-h-12 w-full rounded-2xl border px-3.5 py-3",
                      selected ? "border-primary bg-primary/10" : "border-border bg-input",
                    )}
                    onPress={() =>
                      props.onSelectOption(props.pendingUserInput.requestId, question, optionValue)
                    }
                  >
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text
                        className={cn(
                          "font-t3-bold text-sm",
                          selected ? "text-foreground" : "text-foreground-secondary",
                        )}
                      >
                        {option.label}
                      </Text>
                      {description ? (
                        <Text className="font-sans text-sm leading-5 text-foreground-muted">
                          {description}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {!draft?.attachmentsBlocked &&
            buildPendingUserInputAnswers([question], drafts) === null ? (
              <Text className="text-sm text-foreground-muted">Answer required</Text>
            ) : null}
            <QuestionAttachments
              requestId={props.pendingUserInput.requestId}
              question={question}
              questions={props.pendingUserInput.questions}
              disabled={props.responding}
              value={draft?.customAnswer ?? ""}
              onChangeText={(value) =>
                props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
              }
              onInputFocusChange={(focused) => {
                if (focused)
                  appAtomRegistry.set(questionVoiceTargetAtom, {
                    ownerKey,
                    questionId: question.id,
                  });
                props.onInputFocusChange?.(focused);
              }}
              onFocusInput={props.onFocusInput}
            />
          </View>
        );
      })}

      {focusedQuestion && voice.isAvailable ? (
        <View className="gap-2">
          <Text className="text-sm text-foreground-muted">
            Voice answer: {focusedQuestion.header}
          </Text>
          <View className="flex-row items-center gap-2">
            <ComposerDictationCancelAction presentation={presentation} onCancel={voice.cancel} />
            <ComposerDictationStatus
              audioLevels={voice.audioLevels}
              elapsedSeconds={voice.elapsedSeconds}
              phase={voice.state.phase}
              presentation={presentation}
              onDismissError={voice.cancel}
            />
            <ServerDictationPrimaryAction dictation={voice} disabled={props.responding} />
          </View>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        className={cn(
          "items-center justify-center rounded-2xl px-4 py-3.5",
          answers ? "bg-primary" : "bg-subtle-strong",
        )}
        disabled={answers === null || props.responding || voice.blocksSubmission}
        onPress={() => {
          // Mesura: an answer still waiting for its transcript is not submitted; send mode does
          // not arm a question card, so the user submits again once the text is in.
          if (transcriptionPending) {
            setRefusedForTranscription(true);
            return;
          }
          void props.onSubmit(request.requestId);
        }}
      >
        <Text
          className={cn(
            "font-t3-extrabold text-sm",
            answers ? "text-primary-foreground" : "text-foreground-muted",
          )}
        >
          Submit answers
        </Text>
      </Pressable>
      {refusedForTranscription && transcriptionPending ? (
        <Text className="text-center text-xs text-foreground-muted">
          Waiting for the transcription
        </Text>
      ) : null}
      {request.dismissible ? (
        <Pressable
          accessibilityRole="button"
          className="items-center justify-center rounded-2xl px-4 py-2.5"
          disabled={props.responding}
          onPress={() => {
            voice.cancel();
            void props.onDismiss(request.requestId);
          }}
        >
          <Text className="font-t3-bold text-sm text-foreground-muted">
            Dismiss without answering
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
