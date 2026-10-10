// Edit drawer for an already-registered device.
//
// Adding is a two-step wizard (AddDeviceWizard) because a new device also
// needs its URL pasted into the terminal; editing is just the fields, so it
// stays a plain drawer.
//
// Nothing here touches the connection: the terminal dials us, so there is no
// IP, port or password to change, and the push token is the device's
// permanent identity.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DrawerShell } from "../../components/DrawerShell";
import { extractApiError } from "../../api/client";

import { Icon } from "../../shell/Icon";
import { Field, FormFooter, FormHeader, FormNotice, FormSection, SwitchField } from "../../components/FormKit";
import { usePatchDevice } from "./hooks";
import "./devices.css";
import {
  DRIVER_OPTIONS,
  type Device,
  type DeviceDriver,
  type DevicePatchInput,
} from "./types";

interface Props {
  initial: Device;
  onClose: () => void;
}

export function DeviceDrawer({ initial, onClose }: Props) {
  const { t } = useTranslation();
  const patch = usePatchDevice();

  const [name, setName] = useState(initial.name);
  const [location, setLocation] = useState(initial.location);
  const [driver, setDriver] = useState<DeviceDriver>(initial.driver);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  useEffect(() => {
    setName(initial.name);
    setLocation(initial.location);
    setDriver(initial.driver);
    setEnabled(initial.enabled);
    setError(null);
    setNameError(null);
  }, [initial]);

  const submitting = patch.isPending;

  const submit = async () => {
    setError(null);
    setNameError(null);
    if (!name.trim()) {
      setNameError(
        t("devices.errors.nameRequired", { defaultValue: "Name is required." }),
      );
      return;
    }
    const patchBody: DevicePatchInput = {};
    if (name.trim() !== initial.name) patchBody.name = name.trim();
    if (location.trim() !== initial.location) patchBody.location = location.trim();
    if (driver !== initial.driver) patchBody.driver = driver;
    if (enabled !== initial.enabled) patchBody.enabled = enabled;
    if (Object.keys(patchBody).length === 0) {
      onClose();
      return;
    }
    try {
      await patch.mutateAsync({ id: initial.id, patch: patchBody });
      onClose();
    } catch (err) {
      setError(
        extractApiError(
          err,
          t("devices.errors.saveFailed", {
            defaultValue: "Could not save the device.",
          }),
        ),
      );
    }
  };

  return (
    <DrawerShell onClose={onClose}>
      <form
        className="drawer fk-drawer"
        role="dialog"
        aria-labelledby="dv-edit-title"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!submitting) void submit();
        }}
      >
        <FormHeader
          titleId="dv-edit-title"
          icon={<Icon name="edit" size={18} />}
          eyebrow={initial.name}
          title={t("devices.editTitle", { defaultValue: "Edit device" })}
          subtitle={t("devices.editSubtitle", {
            defaultValue: "Rename or relabel this terminal. The push URL and token never change here.",
          })}
          onClose={onClose}
        />

        <div className="drawer-body fk-body">
          {error && <FormNotice tone="danger">{error}</FormNotice>}

          <FormSection
            step={1}
            title={t("devices.sections.identity", { defaultValue: "Identity" })}
            description={t("devices.wizard.identityHelp", {
              defaultValue: "How the terminal is labelled in Maugood.",
            })}
          >
            <Field
              label={t("devices.fields.name", { defaultValue: "Device name" })}
              htmlFor="dv-edit-name"
              required
              error={nameError}
              help={t("devices.hints.name", {
                defaultValue: "Shown in reports and the device list.",
              })}
            >
              <input
                id="dv-edit-name"
                className="input"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(null);
                }}
                placeholder={t("devices.placeholders.name", {
                  defaultValue: "e.g. Entrance",
                })}
                autoFocus
                maxLength={120}
              />
            </Field>

            <Field
              label={t("devices.fields.location", {
                defaultValue: "Branch / location",
              })}
              htmlFor="dv-edit-location"
            >
              <input
                id="dv-edit-location"
                className="input"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder={t("devices.placeholders.location", {
                  defaultValue: "e.g. Head Office",
                })}
                maxLength={200}
              />
            </Field>

            {/* Learned from the first event — read-only when we have it. */}
            {initial.serial_number && (
              <Field
                label={t("devices.fields.serial", {
                  defaultValue: "Serial number",
                })}
                span={2}
                help={t("devices.hints.serial", {
                  defaultValue: "Reported by the terminal itself — read-only.",
                })}
              >
                <div className="dv-readonly">{initial.serial_number}</div>
              </Field>
            )}
          </FormSection>

          <FormSection
            step={2}
            title={t("devices.sections.integration", { defaultValue: "Integration" })}
            description={t("devices.wizard.integrationHelp", {
              defaultValue: "Which kind of terminal this is and whether to accept its events.",
            })}
          >
            <Field
              label={t("devices.fields.driver", { defaultValue: "Driver" })}
              htmlFor="dv-edit-driver"
              span={2}
              help={t("devices.hints.driver", {
                defaultValue: "Terminal vendor / integration protocol.",
              })}
            >
              <select
                id="dv-edit-driver"
                className="select"
                value={driver}
                onChange={(e) => setDriver(e.target.value as DeviceDriver)}
              >
                {DRIVER_OPTIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Field>

            <SwitchField
              id="dv-edit-enabled"
              checked={enabled}
              onChange={setEnabled}
              label={t("devices.fields.enabled", { defaultValue: "Enabled" })}
              description={t("devices.hints.enabled", {
                defaultValue: "Accept events from this terminal.",
              })}
            />
          </FormSection>
        </div>

        <FormFooter
          onCancel={onClose}
          submitLabel={t("common.save", { defaultValue: "Save changes" })}
          submitting={submitting}
          submittingLabel={t("common.saving")}
          canSubmit={!!name.trim()}
        />
      </form>
    </DrawerShell>
  );
}
