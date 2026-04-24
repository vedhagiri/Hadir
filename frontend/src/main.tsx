import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Hadir design system stylesheets, copied verbatim from the design archive.
// Order matters: enhancements layer over the base.
import "./styles/styles.css";
import "./styles/styles-enhancements.css";
import "./styles/styles-enhancements2.css";
import "./styles/styles-enhancements3.css";

import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element missing from index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
