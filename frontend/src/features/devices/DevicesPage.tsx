// Devices list page — Admin only. Its own nav entry under Operations,
// beside Cameras.
//
// Rows are clickable: opening a device shows its incoming events and the
// people it has reported, which is where the actual operator work happens.
// The push URL is a credential, so it only ever appears inside the setup
// panel — never in the table.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { RelativeTime } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { DeviceDetailDrawer } from "./DeviceDetailDrawer";
import { AddDeviceWizard } from "./AddDeviceWizard";
import { DeviceDrawer } from "./DeviceDrawer";
import { DeviceSetupPanel } from "./DeviceSetupPanel";
import { livenessOf, StatusDot, StatusPill } from "./DeviceStatus";
import { deviceSubtitle } from "./format";
import { useDeleteDevice, useDevices } from "./hooks";
import { type Device } from "./types";

export function DevicesPage() {
  const { t } = useTranslation();
  const list = useDevices();
  const del = useDeleteDevice();

  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Device | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const [detailTarget, setDetailTarget] = useState<Device | null>(null);
  const [setupTarget, setSetupTarget] = useState<Device | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const items = list.data?.items ?? [];

  // Header summary. The counts an operator opens this page to check —
  // "is everything reporting, and is anyone stuck unmapped?" — rather
  // than a bare device count.
  const summary = useMemo(() => {
    let online = 0;
    let waiting = 0;
    let unreachable = 0;
    let unmapped = 0;
    for (const d of items) {
      const state = livenessOf(d);
      if (state === "online") online += 1;
      else if (state === "waiting") waiting += 1;
      else unreachable += 1;
      unmapped += d.users_unmapped;
    }
    return { online, waiting, unreachable, unmapped };
  }, [items]);

  // Re-read the live row so the drawers reflect polled updates instead of
  // the snapshot captured when they were opened.
  const detail = detailTarget
    ? (items.find((d) => d.id === detailTarget.id) ?? detailTarget)
    : null;
  const setup = setupTarget
    ? (items.find((d) => d.id === setupTarget.id) ?? setupTarget)
    : null;

  const openAdd = () => setAddOpen(true);
  const openEdit = (d: Device) => setEditTarget(d);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setRowError(null);
    try {
      await del.mutateAsync(deleteTarget.id);
      if (detailTarget?.id === deleteTarget.id) setDetailTarget(null);
      setDeleteTarget(null);
    } catch (err) {
      setRowError(
        extractApiError(
          err,
          t("devices.errors.deleteFailed", {
            defaultValue: "Could not delete the device.",
          }),
        ),
      );
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t("devices.page.title", { defaultValue: "Devices" })}
          </h1>
          <p className="page-sub">
            {!list.data ? (
              "—"
            ) : items.length === 0 ? (
              t("devices.page.subEmpty", {
                defaultValue: "No attendance devices registered",
              })
            ) : (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <span>
                  {t("devices.page.sub", {
                    count: items.length,
                    defaultValue: `${items.length} attendance devices`,
                  })}
                </span>
                {summary.online > 0 && (
                  <span className="pill pill-success">
                    {t("devices.page.summaryOnline", {
                      count: summary.online,
                      defaultValue: `${summary.online} online`,
                    })}
                  </span>
                )}
                {summary.unreachable > 0 && (
                  <span className="pill pill-danger">
                    {t("devices.page.summaryUnreachable", {
                      count: summary.unreachable,
                      defaultValue: `${summary.unreachable} unreachable`,
                    })}
                  </span>
                )}
                {summary.waiting > 0 && (
                  <span className="pill pill-neutral">
                    {t("devices.page.summaryWaiting", {
                      count: summary.waiting,
                      defaultValue: `${summary.waiting} not reporting yet`,
                    })}
                  </span>
                )}
                {summary.unmapped > 0 && (
                  <span className="pill pill-warning">
                    {t("devices.page.summaryUnmapped", {
                      count: summary.unmapped,
                      defaultValue: `${summary.unmapped} people unmapped`,
                    })}
                  </span>
                )}
              </span>
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openAdd}>
            <Icon name="plus" size={12} />
            {t("devices.page.addDevice", { defaultValue: "Add device" })}
          </button>
        </div>
      </div>

      {rowError && (
        <div
          role="alert"
          style={{
            background: "var(--danger-soft)",
            color: "var(--danger-text)",
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            marginBottom: 12,
          }}
        >
          {rowError}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">
            {t("devices.page.allDevices", { defaultValue: "All devices" })}
          </h3>
          <div className="text-xs text-dim">
            {t("devices.page.clickHint", {
              defaultValue: "Click a device to see its events and people.",
            })}
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t("devices.page.colName", { defaultValue: "Device" })}</th>
              <th style={{ width: 190 }}>
                {t("devices.page.colStatus", { defaultValue: "Status" })}
              </th>
              <th style={{ width: 170 }}>
                {t("devices.page.colPeople", { defaultValue: "People" })}
              </th>
              {/* last_event_at is arrival time of the last POST (keepalives
                  included), not the device-reported tap time. */}
              <th style={{ width: 150 }}>
                {t("devices.page.colLastSeen", { defaultValue: "Last seen" })}
              </th>
              <th style={{ width: 120, textAlign: "end" }}>
                {t("devices.page.colActions", { defaultValue: "Actions" })}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={5} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("devices.page.loading", { defaultValue: "Loading devices…" })}
                </td>
              </tr>
            )}

            {!list.isLoading && items.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 0 }}>
                  <div className="empty" style={{ padding: "36px 20px" }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--text)",
                        marginBottom: 6,
                      }}
                    >
                      {t("devices.page.emptyTitle", {
                        defaultValue: "No devices yet",
                      })}
                    </div>
                    <div style={{ maxWidth: "48ch", margin: "0 auto 14px" }}>
                      {t("devices.page.empty", {
                        defaultValue:
                          "Register a terminal here, then paste the push URL we generate into the device. It starts reporting the moment someone uses it.",
                      })}
                    </div>
                    <button className="btn btn-primary" onClick={openAdd}>
                      <Icon name="plus" size={12} />
                      {t("devices.page.addDevice", {
                        defaultValue: "Add device",
                      })}
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {items.map((d) => {
              const subtitle = deviceSubtitle([
                d.location,
                d.reported_device_name,
                d.serial_number,
              ]);
              return (
                <tr
                  key={d.id}
                  onClick={() => setDetailTarget(d)}
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 10 }}
                    >
                      <StatusDot device={d} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{d.name}</div>
                        {subtitle && (
                          <div className="text-xs text-dim">{subtitle}</div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td>
                    <StatusPill device={d} />
                    {/* A device that has never reported is not broken — it
                        just hasn't been pointed at us yet, and the push URL
                        is the fix. Offer it right where the problem shows. */}
                    {!d.last_event_at && (
                      <div style={{ marginTop: 5 }}>
                        <button
                          className="btn btn-sm btn-ghost"
                          style={{ padding: "1px 4px" }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSetupTarget(d);
                          }}
                        >
                          {t("devices.page.setUp", {
                            defaultValue: "Set up →",
                          })}
                        </button>
                      </div>
                    )}
                    {d.clock_suspect && (
                      <div
                        className="text-xs"
                        style={{
                          marginTop: 4,
                          color: "var(--warning-text, var(--text))",
                        }}
                        title={t("devices.page.clockHint", {
                          defaultValue:
                            "The terminal reported an implausible timestamp — set its clock via NTP.",
                        })}
                      >
                        {t("devices.page.clockSuspect", {
                          defaultValue: "clock not set",
                        })}
                      </div>
                    )}
                  </td>
                  <td>
                    {d.users_total === 0 ? (
                      <span className="text-xs text-dim">
                        {t("devices.page.noPeople", {
                          defaultValue: "nobody seen yet",
                        })}
                      </span>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>
                          {t("devices.page.peopleSeen", {
                            count: d.users_total,
                            defaultValue: `${d.users_total} seen`,
                          })}
                        </span>
                        {d.users_unmapped > 0 && (
                          <span className="pill pill-warning">
                            {t("devices.page.unmappedCount", {
                              count: d.users_unmapped,
                              defaultValue: `${d.users_unmapped} unmapped`,
                            })}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="text-xs text-dim">
                    {d.last_event_at ? (
                      <RelativeTime iso={d.last_event_at} />
                    ) : (
                      t("devices.page.never", { defaultValue: "never" })
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <div
                      className="row-actions"
                      style={{ justifyContent: "flex-end", width: "100%" }}
                    >
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setSetupTarget(d);
                        }}
                        title={t("devices.page.showUrl", {
                          defaultValue: "Show push URL",
                        })}
                        aria-label={t("devices.page.showUrl", {
                          defaultValue: "Show push URL",
                        })}
                      >
                        <Icon name="clipboard" size={13} />
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => openEdit(d)}
                        title={t("common.edit")}
                        aria-label={t("common.edit")}
                      >
                        <Icon name="edit" size={13} />
                      </button>
                      <button
                        className="btn btn-sm btn-ghost danger"
                        onClick={() => setDeleteTarget(d)}
                        title={t("common.delete")}
                        aria-label={t("common.delete")}
                      >
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {addOpen && <AddDeviceWizard onClose={() => setAddOpen(false)} />}

      {editTarget && (
        <DeviceDrawer
          initial={editTarget}
          onClose={() => setEditTarget(null)}
        />
      )}

      {detail && (
        <DeviceDetailDrawer
          device={detail}
          onClose={() => setDetailTarget(null)}
          onShowSetup={() => {
            setSetupTarget(detail);
          }}
        />
      )}

      {setup && (
        <DeviceSetupPanel device={setup} onClose={() => setSetupTarget(null)} />
      )}

      {deleteTarget && (
        <ModalShell onClose={() => setDeleteTarget(null)}>
          <div
            role="dialog"
            aria-label={t("devices.delete.title", { defaultValue: "Delete device" })}
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "min(420px, 92vw)",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              padding: 20,
              boxShadow: "var(--shadow-lg, 0 20px 60px rgba(0,0,0,.3))",
              zIndex: 1000,
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>
              {t("devices.delete.title", { defaultValue: "Delete device" })}
            </h3>
            <p
              style={{
                margin: "0 0 16px",
                fontSize: 13.5,
                color: "var(--text-secondary)",
              }}
            >
              {t("devices.delete.body", {
                name: deleteTarget.name,
                defaultValue: `Remove “${deleteTarget.name}”? Its push URL stops working immediately, and the people and event history recorded for it are removed. This cannot be undone.`,
              })}
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={() => setDeleteTarget(null)}
                disabled={del.isPending}
              >
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-danger"
                onClick={confirmDelete}
                disabled={del.isPending}
              >
                <Icon name="trash" size={12} />
                {del.isPending
                  ? t("common.deleting", { defaultValue: "Deleting…" })
                  : t("common.delete")}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}
