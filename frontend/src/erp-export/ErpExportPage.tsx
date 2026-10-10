// Settings → Integrations → ERP Export. Admin-only.
//
// Operators configure the daily file-drop here: format (CSV / JSON),
// relative output path under the tenant root, cron, and a window
// (default 1 day = today). "Run now" hits POST .../run-now and
// streams the produced file back so the operator can verify the
// schema before pointing the ERP at the directory.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { SkeletonPanel } from "../components/Skeleton";
import { describeCron } from "../scheduled-reports/cronPreview";
import { ChoiceCards, Field, FormSection, SwitchField } from "../components/FormKit";
import {
  Fact,
  Facts,
  InlineAlert,
  LoadErrorPanel,
  SettingsCard,
  SettingsPage,
  SoftPill,
  type PillTone,
} from "../settings/settingsUi";
import { Icon } from "../shell/Icon";
import {
  useErpExportConfig,
  usePatchErpExportConfig,
} from "./hooks";
import type { ErpFormat } from "./types";

import "./erp-export.css";

export function ErpExportPage() {
  const { t } = useTranslation();
  const cfg = useErpExportConfig();
  const patch = usePatchErpExportConfig();

  const [enabled, setEnabled] = useState(false);
  const [format, setFormat] = useState<ErpFormat>("csv");
  const [outputPath, setOutputPath] = useState("");
  const [scheduleCron, setScheduleCron] = useState("");
  const [windowDays, setWindowDays] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!cfg.data) return;
    setEnabled(cfg.data.enabled);
    setFormat(cfg.data.format);
    setOutputPath(cfg.data.output_path);
    setScheduleCron(cfg.data.schedule_cron);
    setWindowDays(cfg.data.window_days);
  }, [cfg.data]);

  const onSave = async () => {
    setError(null);
    setInfo(null);
    try {
      await patch.mutateAsync({
        enabled,
        format,
        output_path: outputPath,
        schedule_cron: scheduleCron,
        window_days: windowDays,
      });
      setInfo(t("erpExport.saved"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("erpExport.saveFailed"));
    }
  };

  const onRunNow = async () => {
    setError(null);
    setInfo(null);
    setRunning(true);
    try {
      const resp = await fetch("/api/erp-export-config/run-now", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!resp.ok) {
        const detail = await resp
          .json()
          .then((b) => b.detail)
          .catch(() => null);
        setError(
          detail ?? t("erpExport.runFailed", { status: resp.status }),
        );
        return;
      }
      const blob = await resp.blob();
      const cd = resp.headers.get("content-disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m
        ? m[1] ?? "maugood-attendance.csv"
        : "maugood-attendance.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setInfo(t("erpExport.runWrote", { filename }));
      cfg.refetch();
    } catch {
      setError(t("erpExport.networkError"));
    } finally {
      setRunning(false);
    }
  };

  const title = t("erpExport.title");
  const subtitle = t("settingsUi.erp.pageSub", {
    defaultValue: "Drop a daily attendance file into a folder your ERP picks up automatically.",
  });

  if (cfg.isLoading)
    return (
      <SettingsPage title={title} subtitle={subtitle}>
        <SkeletonPanel lines={6} />
        <SkeletonPanel lines={2} />
      </SettingsPage>
    );
  if (cfg.error)
    return (
      <SettingsPage title={title} subtitle={subtitle}>
        <LoadErrorPanel title={t("erpExport.loadFailed")} onRetry={() => void cfg.refetch()} />
      </SettingsPage>
    );
  if (!cfg.data)
    return (
      <SettingsPage title={title} subtitle={subtitle}>
        <InlineAlert tone="warning">{t("erpExport.signInRequired")}</InlineAlert>
      </SettingsPage>
    );

  const cronLabel = describeCron(scheduleCron || "");
  const lastStatus = (cfg.data.last_run_status ?? "").toLowerCase();
  const lastTone: PillTone =
    lastStatus === "succeeded" || lastStatus === "success" || lastStatus === "ok"
      ? "success"
      : lastStatus === "failed" || lastStatus === "error"
        ? "danger"
        : lastStatus === "running"
          ? "info"
          : "neutral";

  return (
    <SettingsPage title={title} subtitle={subtitle}>
      <form
        id="erp-export-form"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave();
        }}
      >
        <SettingsCard
          icon={<Icon name="database" size={17} />}
          title={t("settingsUi.erp.configTitle", { defaultValue: "Export settings" })}
          description={
            <>
              {t("erpExport.subtitleMain")}{" "}
              <span className="mono">{cfg.data.tenant_root}</span>{" "}
              {t("erpExport.subtitlePaths")}{" "}
              <span className="mono">docs/erp-file-drop-schema.md</span>{" "}
              {t("erpExport.subtitleSchema")}
            </>
          }
          actions={
            cfg.data.enabled ? (
              <SoftPill tone="success">
                {t("settingsUi.erp.scheduledOn", { defaultValue: "Scheduled" })}
              </SoftPill>
            ) : (
              <SoftPill tone="neutral">
                {t("settingsUi.erp.scheduledOff", { defaultValue: "Not scheduled" })}
              </SoftPill>
            )
          }
          footerNote={
            cfg.data.enabled && scheduleCron && cronLabel !== scheduleCron
              ? cronLabel
              : undefined
          }
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => void onRunNow()}
                disabled={running}
              >
                <Icon name="download" size={12} />
                {running ? t("erpExport.running") : t("erpExport.runNow")}
              </button>
              <button
                type="submit"
                form="erp-export-form"
                className="btn btn-primary"
                disabled={patch.isPending}
              >
                {patch.isPending ? t("erpExport.saving") : t("erpExport.saveChanges")}
              </button>
            </>
          }
        >
          <div className="erp-form">
            <FormSection
              title={t("settingsUi.forms.erp.scheduleSection", { defaultValue: "Schedule" })}
              description={t("settingsUi.forms.erp.scheduleSectionDesc", {
                defaultValue: "Turn the automatic export on and choose when it runs.",
              })}
            >
              <SwitchField
                id="erp-enabled"
                label={t("erpExport.enabledLabel")}
                description={t("settingsUi.erp.enabledHelp", {
                  defaultValue: "When on, the file is written automatically on the cron schedule below.",
                })}
                checked={enabled}
                onChange={setEnabled}
              />
              <Field
                label={t("erpExport.fieldCron")}
                htmlFor="erp-cron"
                help={
                  scheduleCron && cronLabel !== scheduleCron
                    ? cronLabel
                    : t("erpExport.hintCronEmpty")
                }
              >
                <input
                  id="erp-cron"
                  className="input mono"
                  value={scheduleCron}
                  onChange={(e) => setScheduleCron(e.target.value)}
                  placeholder="0 1 * * *"
                />
              </Field>
              <Field
                label={t("erpExport.fieldWindowDays")}
                htmlFor="erp-window-days"
                help={t("settingsUi.erp.windowHelp", {
                  defaultValue: "How many days back each file covers. 1 = today only.",
                })}
              >
                <input
                  id="erp-window-days"
                  className="input"
                  type="number"
                  min={1}
                  max={180}
                  value={windowDays}
                  onChange={(e) => setWindowDays(Number(e.target.value))}
                />
              </Field>
            </FormSection>
            <FormSection
              title={t("settingsUi.forms.erp.fileSection", { defaultValue: "File" })}
              description={t("settingsUi.forms.erp.fileSectionDesc", {
                defaultValue: "The file format and the folder it's written to.",
              })}
            >
              <ChoiceCards<ErpFormat>
                label={t("erpExport.fieldFormat")}
                value={format}
                onChange={setFormat}
                options={[
                  {
                    value: "csv",
                    title: "CSV",
                    description: t("settingsUi.forms.erp.csvDesc", { defaultValue: "UTF-8, one row per employee per day." }),
                    icon: <Icon name="excel" size={15} />,
                  },
                  {
                    value: "json",
                    title: "JSON",
                    description: t("settingsUi.forms.erp.jsonDesc", { defaultValue: "Rows plus a metadata block." }),
                    icon: <Icon name="fileText" size={15} />,
                  },
                ]}
              />
              <Field
                label={t("erpExport.fieldOutputPath")}
                htmlFor="erp-output-path"
                span={2}
                help={
                  outputPath
                    ? t("erpExport.hintPathWithSub", { root: cfg.data.tenant_root, path: outputPath.replace(/^\/+/, "") })
                    : t("erpExport.hintPathRoot", { root: cfg.data.tenant_root })
                }
              >
                <input
                  id="erp-output-path"
                  className="input mono"
                  value={outputPath}
                  onChange={(e) => setOutputPath(e.target.value)}
                  placeholder="incoming/attendance"
                />
              </Field>
            </FormSection>
          </div>
        </SettingsCard>
      </form>

      {error && (
        <InlineAlert tone="danger" role="alert">
          {error}
        </InlineAlert>
      )}
      {info && (
        <InlineAlert tone="success" role="status">
          {info}
        </InlineAlert>
      )}

      <SettingsCard
        icon={<Icon name="clock" size={17} />}
        title={t("erpExport.lastRunTitle")}
        actions={
          cfg.data.last_run_at ? (
            <SoftPill tone={lastTone}>{cfg.data.last_run_status ?? "—"}</SoftPill>
          ) : (
            <SoftPill tone="neutral">
              {t("settingsUi.erp.neverRun", { defaultValue: "Never run" })}
            </SoftPill>
          )
        }
      >
        {cfg.data.last_run_at ? (
          <Facts>
            <Fact
              label={t("erpExport.factWhen")}
              icon={<Icon name="clock" size={11} />}
              value={new Date(cfg.data.last_run_at).toLocaleString()}
            />
            <Fact
              label={t("erpExport.factStatus")}
              icon={<Icon name="activity" size={11} />}
              value={cfg.data.last_run_status ?? "—"}
            />
            {cfg.data.next_run_at && (
              <Fact
                label={t("erpExport.factNextRun")}
                icon={<Icon name="calendar" size={11} />}
                value={new Date(cfg.data.next_run_at).toLocaleString()}
              />
            )}
            <Fact
              label={t("erpExport.factFile")}
              icon={<Icon name="fileText" size={11} />}
              value={cfg.data.last_run_path ?? "—"}
              mono
              full
            />
            {cfg.data.last_run_error && (
              <Fact
                label={t("erpExport.factError")}
                icon={<Icon name="info" size={11} />}
                value={cfg.data.last_run_error}
                full
              />
            )}
          </Facts>
        ) : (
          <div className="st-strip">
            <Icon name="info" size={12} className="text-dim" />
            <span className="text-dim">{t("erpExport.noRuns")}</span>
          </div>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
