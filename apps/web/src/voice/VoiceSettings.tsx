import {
  DEFAULT_CLIENT_SETTINGS,
  VOICE_CONVERSATION_VOICES,
  type EnvironmentId,
  type VoiceConversationLanguage,
  type VoiceConversationMode,
  type VoiceConversationSettings,
  type VoiceConversationVoice,
} from "@t3tools/contracts";
import {
  configureVoiceConversation,
  voiceConversationSettings,
} from "@t3tools/client-runtime/voice-conversation";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";

import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { Button } from "~/components/ui/button";
import { DraftInput } from "~/components/ui/draft-input";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { runtime } from "~/lib/runtime";
import { readPreparedConnection, usePreparedConnection } from "~/state/session";
import {
  resolveVoiceCallPreferences,
  withVoiceLearningSpace,
  type VoiceLearningScope,
} from "./voicePreferences";
import {
  readEnvironmentSupportsVoiceHistory,
  returnFromVoiceSettings,
  useVoiceSettingsReturn,
} from "./voiceHistoryNavigation";

const LANGUAGE_LABELS: Record<VoiceConversationLanguage, string> = {
  es: "Español rioplatense",
  en: "English",
  mixed: "Spanish + English",
};
const MODE_LABELS: Record<VoiceConversationMode, string> = {
  discuss: "Discuss this repository",
  research: "Research a topic or client",
  learn: "Learn from this repository",
};
const voiceLabel = (voice: VoiceConversationVoice) => voice[0]!.toUpperCase() + voice.slice(1);
const DEFAULT_PREFERENCES = DEFAULT_CLIENT_SETTINGS.voiceConversation;

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The voice settings request failed. Try again.";
}

/**
 * Settings > Integrations > Voice calls. Call preferences are saved on this device and apply to
 * the next call. The OpenAI key belongs to the environment selected in Settings.
 */
export function VoiceSettings() {
  const router = useRouter();
  const returnTo = useVoiceSettingsReturn();
  const preferences = useClientSettings((settings) => settings.voiceConversation);
  const updateClientSettings = useUpdateClientSettings();
  const { scope, environment } = useSettingsScope();
  const update = (next: Partial<typeof preferences>) =>
    void updateClientSettings({ voiceConversation: { ...preferences, ...next } });
  const learningScope: VoiceLearningScope | null =
    scope.kind === "checkout"
      ? { environmentId: scope.checkout.environmentId, projectId: scope.checkout.id }
      : scope.kind === "project" && scope.members.length === 1
        ? { environmentId: scope.members[0]!.environmentId, projectId: scope.members[0]!.id }
        : null;

  return (
    <SettingsSection
      id="voice"
      title="Voice calls"
      headerAction={
        returnTo ? (
          <Button size="xs" variant="ghost" onClick={() => returnFromVoiceSettings(router)}>
            <ArrowLeft className="size-3.5" /> Back to thread
          </Button>
        ) : undefined
      }
    >
      <SettingsRow
        {...searchableSetting("voice-call-voice")}
        description="The voice the agent speaks with in your next call."
        resetAction={
          preferences.voice !== DEFAULT_PREFERENCES.voice ? (
            <SettingResetButton
              label="call voice"
              onClick={() => update({ voice: DEFAULT_PREFERENCES.voice })}
            />
          ) : null
        }
        control={
          <Select
            value={preferences.voice}
            onValueChange={(value) => {
              const voice = VOICE_CONVERSATION_VOICES.find((candidate) => candidate === value);
              if (voice) update({ voice });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Voice">
              <SelectValue>{voiceLabel(preferences.voice)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {VOICE_CONVERSATION_VOICES.map((voice) => (
                <SelectItem hideIndicator key={voice} value={voice}>
                  {voiceLabel(voice)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("voice-call-language")}
        description="The language the agent speaks and transcribes."
        control={
          <Select
            value={preferences.language}
            onValueChange={(value) => {
              if (value === "es" || value === "en" || value === "mixed")
                update({ language: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Call language">
              <SelectValue>{LANGUAGE_LABELS[preferences.language]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(LANGUAGE_LABELS) as VoiceConversationLanguage[]).map((language) => (
                <SelectItem hideIndicator key={language} value={language}>
                  {LANGUAGE_LABELS[language]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("voice-call-mode")}
        description="What the call is for. The thread's agent handles questions and tools in every mode."
        control={
          <Select
            value={preferences.mode}
            onValueChange={(value) => {
              if (value === "discuss" || value === "research" || value === "learn")
                update({ mode: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Conversation mode">
              <SelectValue>{MODE_LABELS[preferences.mode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(MODE_LABELS) as VoiceConversationMode[]).map((mode) => (
                <SelectItem hideIndicator key={mode} value={mode}>
                  {MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("voice-call-hands-free")}
        description="Short spoken answers, one question at a time."
        control={
          <Switch
            checked={preferences.handsFree}
            aria-label="Hands-free voice calls"
            onCheckedChange={(checked) => update({ handsFree: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("voice-call-learning-space")}
        description={
          learningScope
            ? "Where Learn mode saves study cards for this project. Leave empty to choose by voice."
            : "Select one project and environment above to set where Learn mode saves its study cards."
        }
        control={
          <DraftInput
            aria-label="Learning App space"
            className="w-full sm:w-56"
            maxLength={120}
            disabled={learningScope === null}
            placeholder="For example, software"
            value={
              learningScope
                ? resolveVoiceCallPreferences(preferences, learningScope).learningSpace
                : ""
            }
            onCommit={(value) => {
              if (learningScope)
                void updateClientSettings({
                  voiceConversation: withVoiceLearningSpace(preferences, learningScope, value),
                });
            }}
          />
        }
      />
      <VoiceKeySetting
        key={environment?.environmentId ?? "none"}
        environmentId={environment?.environmentId ?? null}
        environmentLabel={environment?.label ?? null}
        connected={environment?.connection.phase === "connected"}
      />
    </SettingsSection>
  );
}

/** The selected environment's OpenAI key: its state for everyone, the input only for admins. */
function VoiceKeySetting({
  environmentId,
  environmentLabel,
  connected,
}: {
  environmentId: EnvironmentId | null;
  environmentLabel: string | null;
  connected: boolean;
}) {
  const supported = environmentId !== null && readEnvironmentSupportsVoiceHistory(environmentId);
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  const [settings, setSettings] = useState<VoiceConversationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Environments without voice support have no voice routes; never ask them.
    if (!supported || !connected || !prepared) return;
    let alive = true;
    void runtime.runPromise(voiceConversationSettings(prepared)).then(
      (result) => {
        if (alive) setSettings(result);
      },
      (cause: unknown) => {
        if (alive) setError(errorMessage(cause));
      },
    );
    return () => {
      alive = false;
    };
  }, [connected, prepared, supported]);

  const save = async (nextKey: string) => {
    if (!environmentId) return;
    const current = readPreparedConnection(environmentId);
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await runtime.runPromise(configureVoiceConversation(current, nextKey)));
      setApiKey("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const status = !environmentId
    ? "Select an environment above to see its voice key."
    : !supported
      ? `${environmentLabel ?? "This environment"} does not support voice calls.`
      : !connected
        ? `Connect to ${environmentLabel ?? "this environment"} to see its voice key.`
        : settings === null
          ? "Checking the voice key…"
          : settings.configured
            ? `An OpenAI API key is configured on ${environmentLabel ?? "this environment"}. Voice uses separate API billing.`
            : settings.canConfigure
              ? `Add an OpenAI API key to ${environmentLabel ?? "this environment"}. Voice uses separate API billing.`
              : `An administrator of ${environmentLabel ?? "this environment"} must configure its OpenAI API key.`;

  return (
    <SettingsRow
      {...searchableSetting("voice-openai-key")}
      description={
        <>
          <span>{status}</span>
          {settings?.configured && settings.canConfigure === false ? (
            <span> Only an administrator can change it.</span>
          ) : null}
          {error ? (
            <span role="alert" className="block text-destructive-foreground">
              {error}
            </span>
          ) : null}
        </>
      }
      control={
        settings?.canConfigure ? (
          <form
            className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
            onSubmit={(event) => {
              event.preventDefault();
              void save(apiKey);
            }}
          >
            <Input
              aria-label="OpenAI API key"
              autoComplete="off"
              type="password"
              className="min-w-0 flex-1 sm:w-56"
              placeholder="OpenAI API key"
              value={apiKey}
              disabled={saving}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Button size="sm" variant="outline" type="submit" disabled={saving || !apiKey.trim()}>
              {saving ? "Saving…" : "Save key"}
            </Button>
            {settings.configured ? (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save("")}>
                Remove key
              </Button>
            ) : null}
          </form>
        ) : null
      }
    />
  );
}
