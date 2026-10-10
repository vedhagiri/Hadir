// "Show push URL" — the reference view of an already-registered device.
//
// The add flow uses AddDeviceWizard; this is what you open later from the
// device list when someone needs the URL again (replacing a terminal,
// re-entering it after a factory reset). Same values, shared with the
// wizard via DeviceSetupFields so the two cannot drift apart.

import { useTranslation } from "react-i18next";

import { ModalShell } from "../../components/DrawerShell";
import { FormHeader } from "../../components/FormKit";
import { Icon } from "../../shell/Icon";
import { DeviceSetupFields, DeviceTokenBadge } from "./DeviceSetupFields";
import type { Device } from "./types";
import "./devices.css";

interface Props {
  device: Device;
  onClose: () => void;
}

export function DeviceSetupPanel({ device, onClose }: Props) {
  const { t } = useTranslation();

  return (
    <ModalShell onClose={onClose}>
      <div className="dv-modal-host">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="dv-setup-title"
          className="modal fk-modal dv-wizard"
        >
          <FormHeader
            titleId="dv-setup-title"
            icon={<Icon name="clipboard" size={18} />}
            eyebrow={device.name}
            title={t("devices.setup.title", { defaultValue: "Terminal setup" })}
            subtitle={t("devices.setup.subtitle", {
              defaultValue: "The values to type into the terminal's web page. Treat the URL like a password.",
            })}
            onClose={onClose}
          />
          <div className="fk-body">
            <DeviceSetupFields device={device} />
          </div>
          <div className="drawer-foot fk-foot">
            <div className="fk-foot-note dv-token">
              <DeviceTokenBadge device={device} />
            </div>
            <div className="fk-foot-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                {t("common.done", { defaultValue: "Done" })}
              </button>
            </div>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
