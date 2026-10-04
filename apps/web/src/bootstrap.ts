import { showBootError } from "./lib/bootError";

// Mesura: the desktop's dictation widget window loads only the widget, not the app.
const isDictationWidgetWindow =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location?.search ?? "").get("window") === "dictation-widget";

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
void (isDictationWidgetWindow ? import("./dictation/dictationWidgetMain") : import("./main"))
  .then(({ startup }) => startup)
  .catch(showBootError);
