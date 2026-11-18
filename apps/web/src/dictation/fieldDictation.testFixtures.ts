import { DictationJobId, type DictationJob } from "@t3tools/contracts";
import { vi } from "vite-plus/test";

import { resetMicrophoneClaimForTest } from "../voice/microphoneClaim";
import { createFakeMedia } from "./dictationMedia.testFixtures";
import * as transport from "./dictationTransport";
import { useFieldDictationStore } from "./fieldDictation";
import { publishJobs } from "./fieldDictation.testMocks";
import { setDictationMediaBackend } from "./recorder";

/** Call at the start of each test; the file mocks its modules with `fieldDictation.testMocks`. */
export function setupFieldDictation() {
  const media = createFakeMedia();
  setDictationMediaBackend(media.backend);
  publishJobs([]);
  useFieldDictationStore.setState({
    recording: null,
    pending: {},
    failed: new Set(),
    submitQueued: new Set(),
    stamps: {},
  });
  resetMicrophoneClaimForTest();
  vi.mocked(transport.startDictationTranscription).mockClear();
  vi.mocked(transport.uploadDictationAudio).mockClear();
  return media;
}

export const startedJobIds = () =>
  vi.mocked(transport.startDictationTranscription).mock.calls.map(([, input]) => input.jobId);

export const fieldJob = (jobId: string, overrides: Partial<DictationJob> = {}): DictationJob => ({
  id: DictationJobId.make(jobId),
  target: null,
  mode: "inject",
  status: "transcribing",
  durationMs: 1_000,
  createdAt: "2026-11-18T00:00:00.000Z",
  ...overrides,
});
