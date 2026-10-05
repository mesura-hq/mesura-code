import React from "react";
import ReactDOM from "react-dom/client";

import "../index.css";
import "./dictationWidget.css";

import { DictationWidgetPage } from "./DictationWidget";

/**
 * The entry of the desktop's floating dictation widget window (`?window=dictation-widget`):
 * only the widget, on a transparent page, without the app, its router or a server connection.
 */
document.documentElement.classList.add("dictation-widget-window");
// The desktop's Hyprland window rules match this title; the main process also keeps the window
// title from following the page.
document.title = "mesura-dictation-overlay";

export const startup = Promise.resolve().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <DictationWidgetPage />
    </React.StrictMode>,
  );
});
