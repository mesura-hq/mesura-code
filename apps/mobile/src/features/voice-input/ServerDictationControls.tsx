import type { DictationMode } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import {
  discardDictationJob,
  retryDictationJob,
  useDictationFailures,
} from "../../state/dictation";
import { disarmDictationDraft, useDictationDraftArmed } from "../../state/dictationDrafts";
import { ComposerDictationStartAction, VoiceActionButton } from "./ComposerDictationControl";
import type { DictationController } from "./useDictationController";

const MODE_PRESENTATION: Record<DictationMode, { label: string; icon: AppSymbolName }> = {
  clipboard: { label: "Save", icon: "doc.on.doc" },
  inject: { label: "Insert", icon: "square.and.pencil" },
  submit: { label: "Send", icon: "arrow.up" },
};

/** Where the transcript goes; each tap moves to the next of save, insert and send. */
function DictationModeAction(props: {
  readonly mode: DictationMode;
  readonly onPress: () => void;
}) {
  const presentation = MODE_PRESENTATION[props.mode];
  return (
    <Pressable
      accessibilityLabel={`Dictation mode: ${presentation.label}`}
      accessibilityHint="Changes where the transcription goes"
      accessibilityRole="button"
      className="h-[44px] shrink-0 flex-row items-center gap-1 rounded-full px-2 active:opacity-70"
      onPress={props.onPress}
    >
      <SymbolView
        name={presentation.icon}
        size={14}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
      <Text className="text-xs text-foreground">{presentation.label}</Text>
    </Pressable>
  );
}

/**
 * The trailing toolbar actions of server dictation: the microphone while idle; the mode button
 * and the round stop while recording. Stop drops the marker and sends the audio to the host.
 */
export function ServerDictationPrimaryAction(props: {
  readonly dictation: DictationController;
  readonly disabled?: boolean;
}) {
  const { dictation } = props;
  const phase = dictation.state.phase;
  if (phase !== "recording" && phase !== "preparing") {
    return (
      <ComposerDictationStartAction
        state={dictation.state}
        isAvailable={dictation.isAvailable}
        disabled={props.disabled}
        onStart={dictation.start}
        onCancel={dictation.cancel}
      />
    );
  }
  const preparing = phase === "preparing";
  return (
    <View className="flex-row items-center">
      <DictationModeAction mode={dictation.mode} onPress={dictation.cycleMode} />
      <VoiceActionButton
        accessibilityLabel={preparing ? "Preparing voice input" : "Stop dictation"}
        disabled={preparing}
        icon="checkmark"
        loading={preparing}
        onPress={dictation.stop}
        variant="primary"
      />
    </View>
  );
}

/**
 * What the draft on screen waits for: a recording that did not reach the host, or that the host
 * could not transcribe, keeps its marker and shows why, with Retry (when it can work) and Discard;
 * a draft armed to send when its last marker fills says so, with Don't send.
 */
export function DictationDraftBanner(props: { readonly draftKey: string | null }) {
  const failures = useDictationFailures(props.draftKey);
  const armed = useDictationDraftArmed(props.draftKey);
  const failure = failures[0];
  if (failure) {
    return (
      <View
        accessibilityLabel="Dictation failed"
        className="mx-1 mb-2 flex-row items-center gap-2 rounded-2xl border border-border bg-card px-3 py-1.5"
      >
        <Text className="min-w-0 flex-1 text-xs text-red-400" numberOfLines={2}>
          {failure.message}
        </Text>
        {failure.retryable ? (
          <Pressable
            accessibilityLabel="Retry dictation"
            accessibilityRole="button"
            className="h-8 justify-center px-2 active:opacity-70"
            onPress={() => void retryDictationJob(failure.jobId)}
          >
            <Text className="text-xs font-t3-bold text-foreground">Retry</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityLabel="Discard dictation"
          accessibilityRole="button"
          className="h-8 justify-center px-2 active:opacity-70"
          onPress={() => discardDictationJob(failure.jobId)}
        >
          <Text className="text-xs text-foreground-muted">Discard</Text>
        </Pressable>
      </View>
    );
  }
  if (!armed || props.draftKey === null) return null;
  const { draftKey } = props;
  return (
    <View
      accessibilityLabel="Sends when the transcription finishes"
      className="mx-1 mb-2 flex-row items-center gap-2 rounded-2xl border border-border bg-card px-3 py-1.5"
    >
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        Sends when the transcription finishes
      </Text>
      <Pressable
        accessibilityLabel="Don't send"
        accessibilityRole="button"
        className="h-8 justify-center px-2 active:opacity-70"
        onPress={() => disarmDictationDraft(draftKey)}
      >
        <Text className="text-xs font-t3-bold text-foreground">Don't send</Text>
      </Pressable>
    </View>
  );
}
