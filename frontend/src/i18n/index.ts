// i18next configuration (v1.0 P21).
//
// Detection order: server-resolved user preference (read from
// /api/auth/me on app boot) > localStorage > navigator.language >
// 'en'. The MeProvider in src/auth/AuthProvider.tsx calls
// ``setLanguage(me.preferred_language)`` once on first resolve so a
// fresh session immediately reflects the saved choice.

import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import ar from "./locales/ar.json";
import en from "./locales/en.json";

export const SUPPORTED_LANGUAGES = ["en", "ar"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: SupportedLanguage = "en";

export function isRtl(lang: string): boolean {
  return lang === "ar";
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      ar: { translation: ar },
    },
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: ["en", "ar"],
    nonExplicitSupportedLngs: true, // 'en-US' folds to 'en'
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      lookupLocalStorage: "hadir-language",
      caches: ["localStorage"],
    },
  });

// Keep <html lang> + <html dir> in sync with i18next so screen
// readers + browser line-break logic always match the active
// language. Listeners fire once at boot for the detected lang and
// again on every subsequent change.
function applyLanguageAttributes(lang: string) {
  const root = document.documentElement;
  root.setAttribute("lang", lang);
  root.setAttribute("dir", isRtl(lang) ? "rtl" : "ltr");
}

applyLanguageAttributes(i18n.language || DEFAULT_LANGUAGE);
i18n.on("languageChanged", applyLanguageAttributes);

/**
 * Persist the language locally + on the server. Pass ``null`` to
 * clear the server preference and let the browser drive on the
 * next reload (the server then falls back to Accept-Language).
 */
export async function setLanguage(
  lang: SupportedLanguage | null,
): Promise<void> {
  if (lang === null) {
    // Server-side clear; keep the local choice so the user sees
    // their current selection immediately. The browser will pick up
    // the new server-side fallback on next login.
    await fetch("/api/auth/preferred-language", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferred_language: null }),
    });
    return;
  }
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    throw new Error(`unsupported language: ${lang}`);
  }
  await i18n.changeLanguage(lang);
  try {
    await fetch("/api/auth/preferred-language", {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferred_language: lang }),
    });
  } catch {
    // Network error — local choice still applies until the user
    // signs in again from another browser.
  }
}

/**
 * Apply the server-resolved preference (``preferred_language`` from
 * /api/auth/me) without firing another network call.
 */
export function applyServerPreferred(lang: string | null | undefined): void {
  if (
    typeof lang === "string" &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(lang) &&
    i18n.language !== lang
  ) {
    void i18n.changeLanguage(lang);
  }
}

export default i18n;
