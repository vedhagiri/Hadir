import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";

// Hadir design system stylesheets, copied verbatim from the design archive.
// Order matters: enhancements layer over the base.
import "./styles/styles.css";
import "./styles/styles-enhancements.css";
import "./styles/styles-enhancements2.css";
import "./styles/styles-enhancements3.css";

// P21: i18next config — must run before any component that calls
// ``useTranslation`` mounts. The init also flips <html lang> + <html
// dir="rtl"> on boot for the detected language.
import "./i18n";

// P22: boot the theme + density resolver so the first paint already
// reflects the user's localStorage choice (or the OS-level
// prefers-color-scheme when ``system`` is active). AuthProvider
// applies any server-saved override after /api/auth/me resolves.
import "./theme";

import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element missing from index.html");
}

// One QueryClient for the whole app. Refetch-on-focus is disabled because
// the auth refresh already happens on every API call (sliding expiry in
// backend P3) — extra refetches would just add noise.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
