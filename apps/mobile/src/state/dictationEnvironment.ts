import { createDictationEnvironmentAtoms } from "@t3tools/client-runtime/dictation";

import { connectionAtomRuntime } from "../connection/runtime";

/** Dictation jobs and commands per environment, the same atoms web builds. */
export const dictationEnvironment = createDictationEnvironmentAtoms(connectionAtomRuntime);
