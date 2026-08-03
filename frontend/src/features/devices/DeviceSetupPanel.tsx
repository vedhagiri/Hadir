// "Show push URL" — the reference view of an already-registered device.
//
// The add flow uses AddDeviceWizard; this is what you open later from the
// device list when someone needs the URL again (replacing a terminal,
// re-entering it after a factory reset). Same values, shared with the
// wizard via DeviceSetupFields so the two cannot drift apart.

import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { DeviceSetupFields, DeviceTokenBadge } from "./DeviceSetupFields";
import type { Device } from "./types";

interface Props {
  device: Device;
  onClose: () => void;
}

export function DeviceSetupPanel({ device, onClose }: Props) {
  const { t } = useTranslation();

  return (
    <ModalShell onClose={onClose}>
      <div
        role="dialog"
        aria-label={t("devices.setup.title", { defaultValue: "Terminal setup" })}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "min(520px, 94vw)",
          maxHeight: "86vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          boxShadow: "var(--shadow-lg, 0 20px 60px rgba(0,0,0,.3))",
          zIndex: 1000,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "16px 18px 12px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h3 style={{ margin: 0, fontSize: 15, flex: 1 }}>
            {t("devices.setup.title", { defaultValue: "Terminal setup" })}
          </h3>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ overflowY: "auto", padding: "14px 18px 16px" }}>
          <DeviceSetupFields device={device} />
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "11px 18px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <DeviceTokenBadge device={device} />
          <div style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={onClose}>
            {t("common.done", { defaultValue: "Done" })}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
