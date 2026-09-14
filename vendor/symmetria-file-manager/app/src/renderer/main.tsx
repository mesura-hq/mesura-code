import { App } from "@symmetria/fm-ui/App";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@symmetria/fm-ui/theme/tokens.css";
import "@symmetria/fm-ui/styles.css";
import "@symmetria/fm-ui/syntax-wine.css";

const host = document.getElementById("root");
if (!host) throw new Error("index.html is missing its #root element");

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
