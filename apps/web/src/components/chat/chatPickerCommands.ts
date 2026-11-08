import { dispatchPickerAction, type PickerAction } from "../../lib/pickerActionBus";

// Both the chord listener and the Vim registry use these actions. Keeping them together prevents
// an upstream move of the listener from leaving the fork's commands without keyboard owners.
const pickerCommand =
  (action: PickerAction, suppressRepeats = false) =>
  (context?: { readonly event: KeyboardEvent }) => {
    if (!suppressRepeats || !context?.event.repeat) dispatchPickerAction(action);
  };

export const chatPickerCommands = {
  "traitsPicker.toggle": pickerCommand("traits"),
  "workspacePicker.toggle": pickerCommand("workspace"),
  "branchPicker.toggle": pickerCommand("branch"),
  "composer.workspace": pickerCommand("workspace"),
  "question.toggleCollapse": pickerCommand("question"),
  "runContext.toggle": pickerCommand("runContext.toggle", true),
  "runContext.cycleMachine": pickerCommand("runContext.cycleMachine", true),
  "runContext.toggleWorkspace": pickerCommand("runContext.toggleWorkspace", true),
};
