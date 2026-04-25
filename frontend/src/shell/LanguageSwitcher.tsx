// Topbar EN / العربية toggle (v1.0 P21).
//
// Selecting a language calls ``setLanguage`` which (a) flips i18next
// in-memory so every ``useTranslation`` consumer re-renders, (b)
// writes localStorage for next page load, and (c) PATCHes
// ``/api/auth/preferred-language`` so the same user on another
// browser sees the same UI on next login. The dropdown deliberately
// does NOT reload the page — i18next + the dir/lang flip on <html>
// is enough for every component because all strings already route
// through useTranslation.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { setLanguage, type SupportedLanguage } from "../i18n";

const OPTIONS: { code: SupportedLanguage; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ar", label: "العربية" },
];

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const active = (i18n.language?.split("-")[0] ?? "en") as SupportedLanguage;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const onPick = async (next: SupportedLanguage) => {
    if (next === active) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await setLanguage(next);
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("common.language")}
        className="btn btn-sm"
        style={{ minWidth: 44 }}
      >
        {active === "ar" ? "ع" : "EN"}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t("common.language")}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            insetInlineEnd: 0,
            zIndex: 20,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "var(--shadow-lg)",
            listStyle: "none",
            padding: 4,
            margin: 0,
            minWidth: 140,
          }}
        >
          {OPTIONS.map((opt) => (
            <li key={opt.code}>
              <button
                type="button"
                onClick={() => void onPick(opt.code)}
                disabled={busy}
                role="option"
                aria-selected={opt.code === active}
                style={{
                  width: "100%",
                  textAlign: "start",
                  background:
                    opt.code === active ? "var(--accent-soft)" : "transparent",
                  border: "none",
                  padding: "6px 10px",
                  fontSize: 12.5,
                  color:
                    opt.code === active ? "var(--accent-text)" : "var(--text)",
                  fontWeight: opt.code === active ? 600 : 500,
                  borderRadius: 4,
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
