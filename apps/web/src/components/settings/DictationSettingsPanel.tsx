import { type EnvironmentId, SECRET_SETTING_REDACTION_MARKER } from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { openTranscriptionsList } from "../dictation/TranscriptionsList";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** One hint per line; blank lines and surrounding spaces are dropped. */
function parseVocabularyHints(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Server-side dictation for one environment. The OpenAI key is write-only
 * here: the server keeps it in its secret store and only ever sends the
 * redaction marker back, so the field always starts empty.
 */
export function DictationSettingsPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const dictation = useEnvironmentSettings(environmentId, (settings) => settings.dictation);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const keyConfigured = dictation.openAiApiKey === SECRET_SETTING_REDACTION_MARKER;
  const [keyDraft, setKeyDraft] = useState("");
  // `null` until edited, so the field follows the stored hints until then.
  const [hintsDraft, setHintsDraft] = useState<string | null>(null);
  const hintsText = hintsDraft ?? dictation.vocabularyHints.join("\n");
  const trimmedKey = keyDraft.trim();

  const saveKey = () => {
    if (trimmedKey.length === 0) return;
    updateSettings({ dictation: { openAiApiKey: trimmedKey } });
    setKeyDraft("");
  };

  // An empty key tells the server to delete the stored one.
  const removeKey = () => {
    updateSettings({ dictation: { openAiApiKey: "" } });
    setKeyDraft("");
  };

  const saveHints = () => {
    updateSettings({ dictation: { vocabularyHints: parseVocabularyHints(hintsText) } });
    setHintsDraft(null);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection title="Transcription">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveKey();
          }}
        >
          <SettingsRow
            {...searchableSetting("dictation-openai-key")}
            description="Transcribes dictation on this server. The key stays on the server and is never shown again."
            status={keyConfigured ? "Configured" : "Not configured"}
            control={
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  size="sm"
                  aria-label="OpenAI API key"
                  placeholder={keyConfigured ? "Enter a new key to replace it" : "sk-…"}
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
                <Button type="submit" size="sm" disabled={trimmedKey.length === 0}>
                  Save
                </Button>
                {keyConfigured ? (
                  <Button type="button" size="sm" variant="outline" onClick={removeKey}>
                    Remove key
                  </Button>
                ) : null}
              </div>
            }
          />
        </form>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            saveHints();
          }}
        >
          <SettingsRow
            {...searchableSetting("dictation-vocabulary-hints")}
            description="Names and terms the transcription should spell correctly, one per line."
          >
            <div className="grid gap-2 pt-2">
              <Textarea
                aria-label="Vocabulary hints"
                placeholder={"Mesura\nSymmetria\nHyprland"}
                value={hintsText}
                onChange={(event) => setHintsDraft(event.target.value)}
              />
              <div className="flex justify-end">
                <Button type="submit" size="sm" disabled={hintsDraft === null}>
                  Save
                </Button>
              </div>
            </div>
          </SettingsRow>
        </form>
        <SettingsRow
          title="Transcriptions"
          description="Recent dictation on this server, to copy or retry."
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => openTranscriptionsList(environmentId)}
            >
              Show transcriptions
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
