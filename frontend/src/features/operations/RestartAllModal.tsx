// Restart-all confirmation modal — type-to-confirm.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { Banner, ModalPanel } from "../system/opsUi";

interface Props {
  workerCount: number;
  onCancel: () => void;
  onConfirm: () => void;
  pending: boolean;
}

const CONFIRM_PHRASE = "RESTART ALL";

export function RestartAllModal({ workerCount, onCancel, onConfirm, pending }: Props) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const armed = typed.trim() === CONFIRM_PHRASE;
  const title = t("operations.restart.allTitle", { count: workerCount }) as string;

  return (
    <ModalShell onClose={onCancel}>
      <ModalPanel
        title={title}
        ariaLabel={title}
        footer={
          <>
            <button type="button" className="btn" onClick={onCancel}>
              {t("common.cancel") as string}
            </button>
            <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={!armed || pending}>
              <Icon name="refresh" size={12} />
              {t("operations.restart.allConfirm") as string}
            </button>
          </>
        }
      >
        <Banner tone="danger" icon={<Icon name="info" size={14} />}>
          {t("operations.restart.allWarning") as string}
        </Banner>
        <div className="field" style={{ marginTop: 16 }}>
          <label className="field-label" htmlFor="restart-all-phrase">
            {t("operations.restart.typePhrase", { phrase: CONFIRM_PHRASE }) as string}
          </label>
          <input
            id="restart-all-phrase"
            type="text"
            className="input mono"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            autoFocus
            style={{ width: "100%" }}
          />
        </div>
      </ModalPanel>
    </ModalShell>
  );
}
