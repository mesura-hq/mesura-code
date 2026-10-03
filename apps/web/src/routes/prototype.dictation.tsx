import { createFileRoute } from "@tanstack/react-router";

import { DictationPrototypePage } from "../prototypes/dictation/DictationPrototypePage";

export const Route = createFileRoute("/prototype/dictation")({
  component: DictationPrototypePage,
});
