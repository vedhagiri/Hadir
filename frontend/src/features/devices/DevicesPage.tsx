// Devices list page — Admin only. Lives under the Capture tab strip
// next to Cameras (CaptureTabs). Layout mirrors CamerasPage's
// page-header + card-wrapped table pattern. Per-row Edit / Delete;
// Delete opens a confirmation modal. Credentials never appear in the
// UI — we show host + serial only.

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { ModalShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { CaptureTabs } from "../cameras/CaptureTabs";
import { DeviceDrawer } from "./DeviceDrawer";
import { useDeleteDevice, useDevices, useSyncDeviceUsers } from "./hooks";
import { DRIVER_OPTIONS, type Device } from "./types";

function driverLabel(value: string): string {
  return DRIVER_OPTIONS.find((d) => d.value === value)?.label ?? value;
}

function HealthPill({ status }: { status: Device["health_status"] }) {
  const map: Record<Device["health_status"], { cls: string; key: string; def: string }> = {
    online: { cls: "pill pill-success", key: "devices.health.online", def: "Online" },
    unreachable: { cls: "pill pill-danger", key: "devices.health.unreachable", def: "Unreachable" },
    unknown: { cls: "pill pill-neutral", key: "devices.health.unknown", def: "Unknown" },
  };
  const { cls, key, def } = map[status];
  const { t } = useTranslation();
  return <span className={cls}>{t(key, { defaultValue: def })}</span>;
}

export function DevicesPage() {
  const { t } = useTranslation();
  const list = useDevices();
  const del = useDeleteDevice();
  const syncUsers = useSyncDeviceUsers();

  const [drawerMode, setDrawerMode] = useState<"create" | "edit" | null>(null);
  const [editTarget, setEditTarget] = useState<Device | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Device | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  const items = list.data?.items ?? [];

  const runSync = async (d: Device) => {
    setRowError(null);
    setSyncMsg(null);
    try {
      const r = await syncUsers.mutateAsync(d.id);
      setSyncMsg(
        r.reachable
          ? t("devices.page.syncOk", {
              synced: r.synced,
              unmapped: r.unmapped,
              defaultValue: `${d.name}: ${r.synced} users synced (${r.unmapped} unmapped).`,
            })
          : t("devices.page.syncUnreachable", {
              name: d.name,
              defaultValue: `${d.name} is unreachable — no users pulled. Existing rows kept.`,
            }),
      );
    } catch (err) {
      setRowError(
        extractApiError(err, t("devices.errors.syncFailed", { defaultValue: "Sync failed." })),
      );
    }
  };

  const openAdd = () => {
    setEditTarget(null);
    setDrawerMode("create");
  };
  const openEdit = (d: Device) => {
    setEditTarget(d);
    setDrawerMode("edit");
  };
  const closeDrawer = () => {
    setDrawerMode(null);
    setEditTarget(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setRowError(null);
    try {
      await del.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch (err) {
      setRowError(
        extractApiError(err, t("devices.errors.deleteFailed", { defaultValue: "Could not delete the device." })),
      );
    }
  };

  return (
    <>
      <CaptureTabs active="devices" />

      <div className="page-header">
        <div>
          <h1 className="page-title">{t("devices.page.title", { defaultValue: "Devices" })}</h1>
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

      {syncMsg && (
        <div
          role="status"
          style={{
            background: "var(--success-soft, var(--bg-sunken))",
            color: "var(--text)",
            padding: "8px 12px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            marginBottom: 12,
          }}
        >
          {syncMsg}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">{t("devices.page.allDevices", { defaultValue: "All devices" })}</h3>
          <div className="text-xs text-dim">
            {t("devices.page.credNotice", {
              defaultValue: "Credentials are encrypted and never shown.",
            })}
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>{t("devices.page.colName", { defaultValue: "Device" })}</th>
              <th>{t("devices.page.colSerial", { defaultValue: "Serial" })}</th>
              <th>{t("devices.page.colHost", { defaultValue: "Host" })}</th>
              <th>{t("devices.page.colDriver", { defaultValue: "Driver" })}</th>
              <th style={{ width: 110 }}>{t("devices.page.colStatus", { defaultValue: "Status" })}</th>
              <th style={{ width: 110 }}>{t("devices.page.colUsers", { defaultValue: "Users" })}</th>
              <th>{t("devices.page.colLastSync", { defaultValue: "Last sync" })}</th>
              <th style={{ textAlign: "right" }}>{t("devices.page.colActions", { defaultValue: "Actions" })}</th>
            </tr>
          </thead>
          <tbody>
            {list.isLoading && (
              <tr>
                <td colSpan={8} className="text-sm text-dim" style={{ padding: 16 }}>
                  {t("devices.page.loading", { defaultValue: "Loading devices…" })}
                </td>
              </tr>
            )}

            {!list.isLoading && items.length === 0 && (
              <tr>
                <td colSpan={8} className="text-sm text-dim" style={{ padding: 24, textAlign: "center" }}>
                  {t("devices.page.empty", {
                    defaultValue: "No devices yet — add your first terminal.",
                  })}
                </td>
              </tr>
            )}

            {items.map((d) => (
              <tr key={d.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{d.name}</div>
                  {d.location && <div className="text-xs text-dim">{d.location}</div>}
                </td>
                <td className="mono text-xs">{d.serial_number ?? "—"}</td>
                <td className="mono text-xs">
                  {d.host}:{d.port}
                </td>
                <td>{driverLabel(d.driver)}</td>
                <td>
                  <HealthPill status={d.health_status} />
                </td>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{d.users_synced}</td>
                <td className="text-xs text-dim">
                  {d.last_user_sync_at
                    ? new Date(d.last_user_sync_at).toLocaleString()
                    : t("devices.page.never", { defaultValue: "never" })}
                </td>
                <td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => runSync(d)}
                      disabled={syncUsers.isPending}
                      title={t("devices.page.syncUsers", { defaultValue: "Sync users" })}
                      aria-label={t("devices.page.syncUsers", { defaultValue: "Sync users" })}
                    >
                      <Icon name="refresh" size={12} />
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

      {drawerMode && (
        <DeviceDrawer mode={drawerMode} initial={editTarget} onClose={closeDrawer} />
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
            <p style={{ margin: "0 0 16px", fontSize: 13.5, color: "var(--text-secondary)" }}>
              {t("devices.delete.body", {
                name: deleteTarget.name,
                defaultValue: `Remove “${deleteTarget.name}”? Synced users and event history for this device will be removed. This cannot be undone.`,
              })}
            </p>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setDeleteTarget(null)} disabled={del.isPending}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-danger" onClick={confirmDelete} disabled={del.isPending}>
                <Icon name="trash" size={12} />
                {del.isPending ? t("common.deleting", { defaultValue: "Deleting…" }) : t("common.delete")}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}
