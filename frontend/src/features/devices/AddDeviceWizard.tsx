// Add device — a two-step wizard in one modal.
//
//   1. Details   — name, branch, driver, enabled
//   2. Connect   — the values to type into the terminal
//
// One flow rather than a drawer followed by a separate modal, because the
// second step is not optional: a device with no URL pasted into it is a
// device that will never send anything. Keeping them in the same window
// makes that obvious.
//
// Step 2 has no Back button on purpose — the device is already created and
// its token minted by then, so "back" would imply the registration could be
// undone. Editing afterwards is a separate action from the device list.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Field, FormFooter, FormHeader, FormNotice, FormSection, SwitchField } from "../../components/FormKit";
import { Icon } from "../../shell/Icon";
import { FormStepper } from "../employees/peopleUi";
import { DeviceSetupFields, DeviceTokenBadge } from "./DeviceSetupFields";
import { useCreateDevice } from "./hooks";
import "./devices.css";
import {
  DRIVER_OPTIONS,
  type Device,
  type DeviceCreateInput,
  type DeviceDriver,
} from "./types";

interface Props {
  onClose: () => void;
}

export function AddDeviceWizard({ onClose }: Props) {
  const { t } = useTranslation();
  const create = useCreateDevice();

  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [driver, setDriver] = useState<DeviceDriver>("hikvision");
  const [enabled, setEnabled] = useState(true);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Set once the device exists — which is also what moves us to step 2.
  const [created, setCreated] = useState<Device | null>(null);
  const step = created ? 2 : 1;

  const submit = async () => {
    setError(null);
    setNameError(null);
    if (!name.trim()) {
      setNameError(
        t("devices.errors.nameRequired", { defaultValue: "Name is required." }),
      );
      return;
    }
    const input: DeviceCreateInput = {
      name: name.trim(),
      location: location.trim(),
      driver,
      enabled,
    };
    try {
      setCreated(await create.mutateAsync(input));
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

  const titleId = "add-device-title";
  const header = (
    <>
      <FormHeader
        titleId={titleId}
        icon={<Icon name={step === 1 ? "plus" : "zap"} size={18} />}
        title={t("devices.wizard.title", { defaultValue: "Add device" })}
        subtitle={
          step === 1
            ? t("devices.wizard.subtitle1", {
                defaultValue: "Register a face or fingerprint terminal so its taps become attendance.",
              })
            : t("devices.wizard.subtitle2", {
                defaultValue: "Type these values into the terminal's web page — it will start sending events.",
              })
        }
        // Step 2 is reached only after the device exists — closing then is
        // the same as Finish.
        {...(create.isPending ? {} : { onClose })}
      />
      <FormStepper
        label={t("devices.wizard.stepsLabel", { defaultValue: "Add device steps" })}
        steps={[
          t("devices.wizard.step1", { defaultValue: "Device details" }),
          t("devices.wizard.step2", { defaultValue: "Connect the terminal" }),
        ]}
        current={step}
      />
    </>
  );

  return (
    <ModalShell onClose={onClose}>
      <div className="dv-modal-host">
        {step === 1 ? (
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="modal fk-modal dv-wizard"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!create.isPending) void submit();
            }}
          >
            {header}
            <div className="fk-body">
              {error && <FormNotice tone="danger">{error}</FormNotice>}
              <FormSection
                title={t("devices.sections.identity", { defaultValue: "Identity" })}
                description={t("devices.wizard.identityHelp", {
                  defaultValue: "How the terminal is labelled in Maugood.",
                })}
              >
                <Field
                  label={t("devices.fields.name", { defaultValue: "Device name" })}
                  htmlFor="dv-add-name"
                  required
                  error={nameError}
                  help={t("devices.hints.name", {
                    defaultValue: "Shown in reports and the device list.",
                  })}
                >
                  <input
                    id="dv-add-name"
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
                  htmlFor="dv-add-location"
                >
                  <input
                    id="dv-add-location"
                    className="input"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    placeholder={t("devices.placeholders.location", {
                      defaultValue: "e.g. Head Office",
                    })}
                    maxLength={200}
                  />
                </Field>
              </FormSection>

              <FormSection
                title={t("devices.sections.integration", { defaultValue: "Integration" })}
                description={t("devices.wizard.integrationHelp", {
                  defaultValue: "Which kind of terminal this is and whether to accept its events.",
                })}
              >
                <Field
                  label={t("devices.fields.driver", { defaultValue: "Driver" })}
                  htmlFor="dv-add-driver"
                  span={2}
                  help={t("devices.hints.driver", {
                    defaultValue: "Terminal vendor / integration protocol.",
                  })}
                >
                  <select
                    id="dv-add-driver"
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
                  id="dv-add-enabled"
                  label={t("devices.fields.enabled", { defaultValue: "Enabled" })}
                  description={t("devices.hints.enabled", {
                    defaultValue: "Accept events from this terminal.",
                  })}
                  checked={enabled}
                  onChange={setEnabled}
                />
              </FormSection>

              <FormNotice tone="info">
                {t("devices.wizard.noNetworkNeeded", {
                  defaultValue:
                    "No IP address, port or device password needed — the terminal connects to us. Its serial and model are learned from the first event it sends.",
                })}
              </FormNotice>
            </div>
            <FormFooter
              onCancel={onClose}
              submitLabel={
                <>
                  {t("devices.wizard.continue", { defaultValue: "Continue" })}
                  <Icon name="chevronRight" size={12} />
                </>
              }
              submitting={create.isPending}
              submittingLabel={t("common.saving")}
              canSubmit={!!name.trim()}
            />
          </form>
        ) : (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="modal fk-modal dv-wizard"
          >
            {header}
            {/* No Back on purpose — the device and its token already
                exist, so "back" would imply the registration could be
                undone. Editing is a separate action from the list. */}
            <div className="fk-body">
              <FormNotice
                tone="success"
                title={t("devices.wizard.createdTitle", {
                  name: created?.name ?? "",
                  defaultValue: "“{{name}}” is registered",
                })}
              >
                {t("devices.wizard.createdBody", {
                  defaultValue: "It shows as “Not reporting yet” until the terminal sends its first event.",
                })}
              </FormNotice>
              {created && <DeviceSetupFields device={created} />}
            </div>
            <div className="drawer-foot fk-foot">
              <div className="fk-foot-note dv-token">
                {created && <DeviceTokenBadge device={created} />}
              </div>
              <div className="fk-foot-actions">
                <button type="button" className="btn btn-primary" onClick={onClose}>
                  <Icon name="check" size={12} />
                  {t("devices.wizard.finish", { defaultValue: "Finish" })}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}
