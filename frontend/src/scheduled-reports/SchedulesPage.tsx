// Settings → Report Schedules. Admin-managed list; HR can read.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ApiError } from "../api/client";
import { Icon } from "../shell/Icon";
import { describeCron } from "./cronPreview";
import {
  useCreateSchedule,
  useDeleteSchedule,
  usePatchSchedule,
  useReportRuns,
  useReportSchedules,
  useRunNow,
} from "./hooks";
import type {
  ReportFormat,
  ReportSchedule,
  ReportScheduleCreateInput,
} from "./types";
import { SkeletonTable } from "../components/Skeleton";
import { DrawerShell } from "../components/DrawerShell";
import { ChoiceCards, Field, FormFooter, FormHeader, FormNotice, FormSection } from "../components/FormKit";
import { EmptyPanel } from "../components/ListPageUi";
import {
  ConfirmModal,
  InlineAlert,
  LoadErrorPanel,
  SettingsCard,
  SettingsPage,
  SoftPill,
  type PillTone,
} from "../settings/settingsUi";

export function SchedulesPage() {
  const { t } = useTranslation();
  const schedules = useReportSchedules();
  const create = useCreateSchedule();
  const patch = usePatchSchedule();
  const remove = useDeleteSchedule();
  const runNow = useRunNow();
  const recentRuns = useReportRuns(null);

  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const onRunNow = async (s: ReportSchedule) => {
    setError(null);
    setInfo(null);
    try {
      const run = await runNow.mutateAsync(s.id);
      setInfo(
        run.status === "succeeded"
          ? t("schedules.runSent", {
              count: run.recipients_delivered_to.length,
              delivery: run.delivery_mode,
            })
          : t("schedules.runStatus", {
              status: run.status,
              detail: run.error_message ?? t("schedules.seeRunsLog"),
            }),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("schedules.errRun"));
    }
  };

  const onToggleActive = (s: ReportSchedule) => {
    patch.mutate({ id: s.id, input: { active: !s.active } });
  };

  const [deleting, setDeleting] = useState<ReportSchedule | null>(null);
  const onDelete = (s: ReportSchedule) => setDeleting(s);
  const confirmDelete = () => {
    if (!deleting) return;
    remove.mutate(deleting.id, { onSettled: () => setDeleting(null) });
  };

  const items = schedules.data ?? [];
  const activeCount = items.filter((x) => x.active).length;
  const runs = recentRuns.data ?? [];

  const headerAction = (
    <button
      type="button"
      className="btn btn-primary"
      onClick={() => setShowCreate(true)}
      aria-expanded={showCreate}
    >
      <Icon name="plus" size={12} /> {t("schedules.newSchedule")}
    </button>
  );

  return (
    <SettingsPage title={t("schedules.title")} subtitle={t("schedules.subtitle")} actions={headerAction} wide>
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      {info && <InlineAlert tone="success">{info}</InlineAlert>}

      {showCreate && (
        <CreateForm
          onCreate={(input) => create.mutateAsync(input)}
          onClose={() => setShowCreate(false)}
        />
      )}
      {deleting && (
        <ConfirmModal
          titleId="sch-delete-title"
          title={t("settingsUi.forms.schedules.deleteTitle", { defaultValue: "Delete schedule" })}
          subtitle={t("settingsUi.forms.schedules.deleteSub", {
            defaultValue: "The schedule stops sending. Past runs stay in the log.",
          })}
          confirmLabel={t("schedules.delete")}
          busy={remove.isPending}
          onConfirm={confirmDelete}
          onClose={() => setDeleting(null)}
        >
          <p className="st-confirm-text">{t("schedules.confirmDelete", { name: deleting.name })}</p>
        </ConfirmModal>
      )}

      <SettingsCard
        icon={<Icon name="calendar" size={17} />}
        title={t("settingsUi.schedules.listTitle", { defaultValue: "Schedules" })}
        description={t("settingsUi.schedules.listDesc", {
          defaultValue: "Each schedule emails an attendance report to its recipients on a repeating timetable.",
        })}
        actions={
          !schedules.isLoading && items.length > 0 ? (
            <SoftPill tone={activeCount > 0 ? "success" : "neutral"}>
              {t("settingsUi.schedules.activeCount", {
                defaultValue: "{{active}} of {{total}} active",
                active: activeCount,
                total: items.length,
              })}
            </SoftPill>
          ) : undefined
        }
        tight
      >
        {schedules.isLoading ? (
          <SkeletonTable rows={3} cols={7} />
        ) : schedules.isError ? (
          <LoadErrorPanel
            title={t("settingsUi.schedules.loadFailed", { defaultValue: "Couldn't load schedules" })}
            onRetry={() => void schedules.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyPanel
            tone="accent"
            icon={<Icon name="calendar" size={28} />}
            title={t("schedules.emptySchedules")}
            body={t("settingsUi.schedules.emptyBody", {
              defaultValue: "Create a schedule to email a PDF or Excel attendance report automatically, for example every Monday morning.",
            })}
            actions={
              !showCreate ? (
                <button type="button" className="btn" onClick={() => setShowCreate(true)}>
                  <Icon name="plus" size={12} />
                  {t("schedules.newSchedule")}
                </button>
              ) : undefined
            }
          />
        ) : (
          <div className="st-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("schedules.col.name")}</th>
                  <th>{t("schedules.col.format")}</th>
                  <th>{t("schedules.col.schedule")}</th>
                  <th>{t("schedules.col.recipients")}</th>
                  <th>{t("schedules.col.lastRun")}</th>
                  <th>{t("schedules.col.nextRun")}</th>
                  <th
                    style={{ textAlign: "end" }}
                    aria-label={t("settingsUi.actions", { defaultValue: "Actions" })}
                  />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="st-inline">
                        <span style={{ fontWeight: 600 }}>{s.name}</span>
                        {s.active ? (
                          <SoftPill tone="success">{t("settingsUi.schedules.active", { defaultValue: "Active" })}</SoftPill>
                        ) : (
                          <SoftPill tone="neutral">{t("settingsUi.schedules.paused", { defaultValue: "Paused" })}</SoftPill>
                        )}
                      </div>
                      <div className="text-xs text-dim">
                        {t("schedules.windowDays", { days: s.filter_config.window_days })}
                      </div>
                    </td>
                    <td>
                      <SoftPill tone={s.format === "pdf" ? "info" : "success"} dot={false}>
                        {s.format.toUpperCase()}
                      </SoftPill>
                    </td>
                    <td>
                      <div>{describeCron(s.schedule_cron)}</div>
                      <div className="text-xs text-dim mono" style={{ whiteSpace: "nowrap" }}>
                        {s.schedule_cron}
                      </div>
                    </td>
                    <td title={s.recipients.join(", ")}>{s.recipients.length}</td>
                    <td>
                      {s.last_run_at ? (
                        <div className="st-inline">
                          <span className="text-xs mono" style={{ whiteSpace: "nowrap" }}>
                            {new Date(s.last_run_at).toLocaleString()}
                          </span>
                          <SoftPill tone={runTone(s.last_run_status)}>
                            {t(`schedules.status.${s.last_run_status}`, s.last_run_status ?? "")}
                          </SoftPill>
                        </div>
                      ) : (
                        <span className="text-dim">—</span>
                      )}
                    </td>
                    <td className="text-xs mono" style={{ whiteSpace: "nowrap" }}>
                      {s.next_run_at
                        ? new Date(s.next_run_at).toLocaleString()
                        : "—"}
                    </td>
                    <td>
                      <div className="st-row-actions">
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => void onRunNow(s)}
                          disabled={runNow.isPending}
                        >
                          <Icon name="play" size={11} />
                          {t("schedules.runNow")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => onToggleActive(s)}
                          disabled={patch.isPending}
                        >
                          <Icon name={s.active ? "pause" : "play"} size={11} />
                          {s.active ? t("schedules.pause") : t("schedules.resume")}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost st-danger"
                          onClick={() => onDelete(s)}
                          disabled={remove.isPending}
                        >
                          <Icon name="trash" size={11} />
                          {t("schedules.delete")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        icon={<Icon name="activity" size={17} />}
        title={t("schedules.recentRunsTitle")}
        description={t("settingsUi.schedules.runsDesc", {
          defaultValue: "The last 20 deliveries across every schedule, newest first.",
        })}
        tight
      >
        {recentRuns.isLoading ? (
          <SkeletonTable rows={3} cols={7} />
        ) : recentRuns.isError ? (
          <LoadErrorPanel
            title={t("settingsUi.schedules.runsLoadFailed", { defaultValue: "Couldn't load recent runs" })}
            onRetry={() => void recentRuns.refetch()}
          />
        ) : runs.length === 0 ? (
          <EmptyPanel
            icon={<Icon name="activity" size={28} />}
            title={t("schedules.emptyRuns")}
            body={t("settingsUi.schedules.emptyRunsBody", {
              defaultValue: "Runs appear here once a schedule fires or you press Run now.",
            })}
          />
        ) : (
          <div className="st-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("schedules.runs.run")}</th>
                  <th>{t("schedules.runs.schedule")}</th>
                  <th>{t("schedules.runs.status")}</th>
                  <th>{t("schedules.runs.delivery")}</th>
                  <th>{t("schedules.runs.size")}</th>
                  <th>{t("schedules.runs.started")}</th>
                  <th>{t("schedules.runs.finished")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 20).map((r) => (
                  <tr key={r.id}>
                    <td className="mono text-xs">#{r.id}</td>
                    <td className="mono text-xs">
                      {r.schedule_id ? `#${r.schedule_id}` : "—"}
                    </td>
                    <td>
                      <SoftPill tone={runTone(r.status)} {...(r.error_message ? { title: r.error_message } : {})}>
                        {t(`schedules.status.${r.status}`, r.status)}
                      </SoftPill>
                    </td>
                    <td className="text-xs">{r.delivery_mode ?? "—"}</td>
                    <td className="mono text-xs">
                      {r.file_size_bytes != null
                        ? `${(r.file_size_bytes / 1024).toFixed(0)} KB`
                        : "—"}
                    </td>
                    <td className="text-xs mono" style={{ whiteSpace: "nowrap" }}>
                      {new Date(r.started_at).toLocaleString()}
                    </td>
                    <td className="text-xs mono" style={{ whiteSpace: "nowrap" }}>
                      {r.finished_at
                        ? new Date(r.finished_at).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}

function runTone(status: string | null): PillTone {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "running") return "info";
  return "warning";
}

// ---------------------------------------------------------------------------

function CreateForm({
  onCreate,
  onClose,
}: {
  onCreate: (input: ReportScheduleCreateInput) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [format, setFormat] = useState<ReportFormat>("pdf");
  const [windowDays, setWindowDays] = useState(7);
  const [recipientsText, setRecipientsText] = useState("");
  const [cronExpr, setCronExpr] = useState("0 8 * * 1");
  const [error, setError] = useState<string | null>(null);
  const [recipientsError, setRecipientsError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const cronLabel = describeCron(cronExpr);
  const dirty = name !== "" || recipientsText !== "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setRecipientsError(null);
    const recipients = recipientsText
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      setRecipientsError(t("schedules.errRecipientsRequired"));
      return;
    }
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        format,
        filter_config: { window_days: windowDays },
        recipients,
        schedule_cron: cronExpr.trim(),
        active: true,
      });
      setName("");
      setRecipientsText("");
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("schedules.errSave"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DrawerShell onClose={onClose} dirty={dirty}>
      <form className="drawer fk-drawer" onSubmit={submit} noValidate aria-labelledby="sch-create-title">
        <FormHeader
          icon={<Icon name="calendar" size={18} />}
          title={t("settingsUi.forms.schedules.addTitle", { defaultValue: "New report schedule" })}
          subtitle={t("settingsUi.schedules.createDesc", {
            defaultValue: "Pick a format, how many days each report covers, when it runs and who receives it.",
          })}
          onClose={onClose}
          titleId="sch-create-title"
        />
        <div className="drawer-body fk-body">
          {error && <FormNotice tone="danger">{error}</FormNotice>}
          <FormSection
            step={1}
            title={t("settingsUi.forms.schedules.reportSection", { defaultValue: "Report" })}
            description={t("settingsUi.forms.schedules.reportSectionDesc", {
              defaultValue: "What the email contains and how many days it covers.",
            })}
          >
            <Field label={t("schedules.field.name")} htmlFor="sch-name" required span={2}>
              <input
                id="sch-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("schedules.field.namePlaceholder")}
              />
            </Field>
            <Field label={t("schedules.field.format")} span={2}>
              <ChoiceCards<ReportFormat>
                label={t("schedules.field.format")}
                value={format}
                onChange={setFormat}
                options={[
                  {
                    value: "pdf",
                    title: "PDF",
                    description: t("settingsUi.forms.schedules.pdfDesc", { defaultValue: "Branded, print-ready report." }),
                    icon: <Icon name="fileText" size={15} />,
                  },
                  {
                    value: "xlsx",
                    title: "Excel",
                    description: t("settingsUi.forms.schedules.xlsxDesc", { defaultValue: "Spreadsheet for further analysis." }),
                    icon: <Icon name="excel" size={15} />,
                  },
                ]}
              />
            </Field>
            <Field
              label={t("schedules.field.windowDays")}
              htmlFor="sch-window"
              required
              help={t("settingsUi.forms.schedules.windowHelp", { defaultValue: "Between 1 and 180 days, ending on the run date." })}
            >
              <input
                id="sch-window"
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
            step={2}
            title={t("settingsUi.forms.schedules.timingSection", { defaultValue: "Timetable" })}
            description={t("settingsUi.forms.schedules.timingSectionDesc", {
              defaultValue: "A cron expression in the tenant's timezone.",
            })}
          >
            <Field
              label={t("schedules.field.cron")}
              htmlFor="sch-cron"
              required
              help={cronLabel === cronExpr ? t("settingsUi.forms.schedules.cronHelp", { defaultValue: "minute hour day month weekday — e.g. 0 8 * * 1" }) : cronLabel}
            >
              <input
                id="sch-cron"
                className="input mono"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="0 8 * * 1"
              />
            </Field>
          </FormSection>
          <FormSection
            step={3}
            title={t("settingsUi.forms.schedules.recipientsSection", { defaultValue: "Recipients" })}
            description={t("settingsUi.forms.schedules.recipientsSectionDesc", {
              defaultValue: "Separate addresses with commas or new lines.",
            })}
          >
            <Field
              label={t("schedules.field.recipients")}
              htmlFor="sch-recipients"
              required
              span={2}
              error={recipientsError}
            >
              <textarea
                id="sch-recipients"
                className="textarea"
                rows={3}
                value={recipientsText}
                onChange={(e) => {
                  setRecipientsText(e.target.value);
                  if (recipientsError) setRecipientsError(null);
                }}
                placeholder={t("schedules.field.recipientsPlaceholder")}
              />
            </Field>
          </FormSection>
        </div>
        <FormFooter
          onCancel={onClose}
          submitLabel={t("schedules.saveSchedule")}
          submitting={submitting}
          canSubmit={name.trim() !== "" && cronExpr.trim() !== ""}
        />
      </form>
    </DrawerShell>
  );
}
