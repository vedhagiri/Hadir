// Restart-all confirmation modal — type-to-confirm.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";

interface Props {
  workerCount: number;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}

const CONFIRM_PHRASE = "RESTART ALL";

export function RestartAllModal({
  workerCount,
  onCancel,
  onConfirm,
  pending,
}: Props) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const armed = typed.trim() === CONFIRM_PHRASE;

  return (
    <ModalShell onClose={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "fixed",
          top: "50%",
          insetInlineStart: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 51,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg)",
          width: 480,
          maxWidth: "calc(100vw - 32px)",
          padding: 20,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          {t("operations.restart.allTitle", { count: workerCount }) as string}
        </h3>
        <div
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            padding: "10px 12px",
            borderRadius: "var(--radius-sm)",
            marginTop: 12,
            fontSize: 13,
          }}
        >
          {t("operations.restart.allWarning") as string}
        </div>
        <label
          className="text-xs"
          style={{
            display: "block",
            marginTop: 14,
            color: "var(--text-secondary)",
          }}
        >
          {t("operations.restart.typePhrase", { phrase: CONFIRM_PHRASE }) as string}
        </label>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={CONFIRM_PHRASE}
          autoFocus
          style={{
            width: "100%",
            marginTop: 4,
            padding: "8px 10px",
            fontSize: 13,
            border: `1px solid ${armed ? "var(--danger-text)" : "var(--border)"}`,
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-elev)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 18,
          }}
        >
          <button type="button" className="btn" onClick={onCancel}>
            {t("common.cancel") as string}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{
              background: armed ? "var(--danger)" : undefined,
              color: armed ? "white" : undefined,
              opacity: armed ? 1 : 0.5,
            }}
            onClick={onConfirm}
            disabled={!armed || pending}
          >
            {t("operations.restart.allConfirm") as string}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
