// Devices list page — Admin only. Its own nav entry under Operations,
// beside Cameras.
//
// Rows are clickable: opening a device shows its incoming events and the
// people it has reported, which is where the actual operator work happens.
// The push URL is a credential, so it only ever appears inside the setup
// panel — never in the table.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { DeviceDetailDrawer } from "./DeviceDetailDrawer";
import { AddDeviceWizard } from "./AddDeviceWizard";
import { DeviceDrawer } from "./DeviceDrawer";
import { DeviceSetupPanel } from "./DeviceSetupPanel";
import { useDeleteDevice, useDevices } from "./hooks";
import { type Device } from "./types";

function StatusPill({ device }: { device: Device }) {
  const { t } = useTranslation();

  // A push device cannot be pinged, so "online" means it has actually sent
  // us something — not that a probe succeeded.
  if (!device.last_event_at) {
    return (
      <span className="pill pill-neutral">
        {t("devices.health.waiting", { defaultValue: "Waiting for first event" })}
      </span>
    );
  }
  if (device.health_status === "unreachable") {
    return (
      <span className="pill pill-danger">
        {t("devices.health.unreachable", { defaultValue: "Unreachable" })}
      </span>
    );
  }
  return (
    <span className="pill pill-success">
      {t("devices.health.online", { defaultValue: "Online" })}
    </span>
  );
}

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
            {list.data
              ? t("devices.page.sub", {
                  count: items.length,
                  defaultValue: `${items.length} attendance devices`,
                })
              : "—"}
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
              <th>{t("devices.page.colBranch", { defaultValue: "Branch" })}</th>
              <th style={{ width: 150 }}>
                {t("devices.page.colStatus", { defaultValue: "Status" })}
              </th>
              <th style={{ width: 90, textAlign: "end" }}>
                {t("devices.page.colPeople", { defaultValue: "People" })}
              </th>
              <th style={{ width: 100, textAlign: "end" }}>
                {t("devices.page.colUnmapped", { defaultValue: "Unmapped" })}
              </th>
              {/* last_event_at is arrival time of the last POST (keepalives
                  included), not the device-reported tap time. */}
              <th>
                {t("devices.page.colLastSeen", { defaultValue: "Last seen" })}
              </th>
              <th style={{ textAlign: "right" }}>
                {t("devices.page.colActions", { defaultValue: "Actions" })}
              </th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={7} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("devices.page.loading", { defaultValue: "Loading devices…" })}
                </td>
              </tr>
            )}

            {!list.isLoading && items.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="text-sm text-dim"
                  style={{ padding: 24, textAlign: "center" }}
                >
                  {t("devices.page.empty", {
                    defaultValue: "No devices yet — add your first terminal.",
                  })}
                </td>
              </tr>
            )}

            {items.map((d) => (
              <tr
                key={d.id}
                onClick={() => setDetailTarget(d)}
                style={{ cursor: "pointer" }}
              >
                <td>
                  <div style={{ fontWeight: 600 }}>{d.name}</div>
                  {d.serial_number && (
                    <div className="text-xs text-dim mono">{d.serial_number}</div>
                  )}
                </td>
                <td>{d.location || <span className="text-dim">—</span>}</td>
                <td>
                  <StatusPill device={d} />
                  {d.clock_suspect && (
                    <div
                      className="text-xs"
                      style={{ color: "var(--warning-text, var(--text))" }}
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
                <td
                  style={{ textAlign: "end", fontVariantNumeric: "tabular-nums" }}
                >
                  {d.users_total}
                </td>
                <td style={{ textAlign: "end" }}>
                  {d.users_unmapped > 0 ? (
                    <span className="pill pill-warning">{d.users_unmapped}</span>
                  ) : (
                    <span className="text-dim">0</span>
                  )}
                </td>
                <td className="text-xs text-dim">
                  {d.last_event_at
                    ? new Date(d.last_event_at).toLocaleString()
                    : t("devices.page.never", { defaultValue: "never" })}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div
                    style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
                  >
                    <button
                      className="btn btn-sm"
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
                      <Icon name="clipboard" size={12} />
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => openEdit(d)}
                      title={t("common.edit")}
                      aria-label={t("common.edit")}
                    >
                      <Icon name="edit" size={12} />
                    </button>
                    <button
                      className="btn btn-sm"
                      onClick={() => setDeleteTarget(d)}
                      title={t("common.delete")}
                      aria-label={t("common.delete")}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
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
