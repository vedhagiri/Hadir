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
import {
  CardGrid,
  EmptyPanel,
  FilterSelect,
  KebabMenu,
  ResetButton,
  SearchField,
  StatCard,
  StatGrid,
  Toolbar,
  ViewToggle,
  gridCardStyle,
  pct,
  useViewMode,
} from "../../components/ListPageUi";
import { Icon } from "../../shell/Icon";
import { DeviceDetailDrawer } from "./DeviceDetailDrawer";
import { AddDeviceWizard } from "./AddDeviceWizard";
import { DeviceDrawer } from "./DeviceDrawer";
import { DeviceSetupPanel } from "./DeviceSetupPanel";
import { livenessOf, type Liveness } from "./DeviceStatus";
import { deviceSubtitle } from "./format";
import { useDeleteDevice, useDeviceEvents, useDevices } from "./hooks";
import { BrandLogo } from "../cameras/BrandLogo";
import { TerminalArt } from "../../components/DeviceArt";
import { DRIVER_OPTIONS, type Device } from "./types";
import { SkeletonCards, SkeletonGrid, SkeletonTable } from "../../components/Skeleton";

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

  // Search + filters (client-side; a tenant has a handful of terminals).
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState<Liveness | "">("");
  const [brandF, setBrandF] = useState("");
  const [view, setView] = useViewMode("maugood.devices.view");
  const needle = q.trim().toLowerCase();
  const filtered = items.filter((d) => {
    if (statusF && livenessOf(d) !== statusF) return false;
    if (brandF && d.driver !== brandF) return false;
    if (needle) {
      const hay = [d.name, d.location, d.serial_number ?? "", d.model ?? "", d.reported_device_name ?? "", driverLabel(d.driver)]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  const filtersOn = !!(q || statusF || brandF);
  const resetFilters = () => {
    setQ("");
    setStatusF("");
    setBrandF("");
  };
  const brandsInUse = DRIVER_OPTIONS.filter((o) => items.some((d) => d.driver === o.value));

  // Header summary. The counts an operator opens this page to check —
  // "is everything reporting, and is anyone stuck unmapped?" — rather
  // than a bare device count.
  const summary = useMemo(() => {
    let online = 0;
    let waiting = 0;
    let unreachable = 0;
    let unmapped = 0;
    let seen = 0;
    for (const d of items) {
      seen += d.users_total;
      const state = livenessOf(d);
      if (state === "online") online += 1;
      else if (state === "waiting") waiting += 1;
      else unreachable += 1;
      unmapped += d.users_unmapped;
    }
    return { online, waiting, unreachable, unmapped, seen };
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
            {t("devices.list.subtitle", {
              defaultValue: "Manage the fingerprint and face terminals that record attendance",
            })}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openAdd}>
            <Icon name="plus" size={12} />
            {t("devices.page.addDevice", { defaultValue: "Add device" })}
          </button>
        </div>
      </div>

      {list.isLoading ? (
        <div style={{ marginBottom: 14 }}>
          <SkeletonCards count={4} minWidth={220} />
        </div>
      ) : (
      <StatGrid>
        <StatCard
          tone="info"
          icon={DEVICE_ICON.total}
          label={t("devices.list.total", { defaultValue: "Total devices" })}
          value={items.length}
          sub={
            summary.unmapped > 0
              ? t("devices.list.totalSubUnmapped", { seen: summary.seen, unmapped: summary.unmapped, defaultValue: `${summary.seen} people seen · ${summary.unmapped} unmapped` })
              : t("devices.list.totalSub", { seen: summary.seen, defaultValue: `${summary.seen} people seen` })
          }
          active={statusF === ""}
          onClick={() => setStatusF("")}
        />
        <StatCard
          tone="success"
          icon={DEVICE_ICON.online}
          label={t("devices.health.online", { defaultValue: "Online" })}
          value={summary.online}
          sub={t("devices.list.pctSub", { pct: pct(summary.online, items.length), defaultValue: `${pct(summary.online, items.length)}% of devices` })}
          active={statusF === "online"}
          onClick={() => setStatusF("online")}
        />
        <StatCard
          tone="neutral"
          icon={DEVICE_ICON.waiting}
          label={t("devices.list.waiting", { defaultValue: "Not reporting yet" })}
          value={summary.waiting}
          sub={t("devices.list.waitingSub", { defaultValue: "Waiting for the first event" })}
          active={statusF === "waiting"}
          onClick={() => setStatusF("waiting")}
        />
        <StatCard
          tone="danger"
          icon={DEVICE_ICON.unreachable}
          label={t("devices.health.unreachable", { defaultValue: "Unreachable" })}
          value={summary.unreachable}
          sub={t("devices.list.pctSub", { pct: pct(summary.unreachable, items.length), defaultValue: `${pct(summary.unreachable, items.length)}% of devices` })}
          active={statusF === "unreachable"}
          onClick={() => setStatusF("unreachable")}
        />
      </StatGrid>
      )}

      <Toolbar>
        <SearchField
          value={q}
          onChange={setQ}
          placeholder={t("devices.list.search", { defaultValue: "Search by name, location, serial or model…" })}
          clearLabel={t("devices.list.clearSearch", { defaultValue: "Clear search" })}
        />
        <FilterSelect
          label={t("devices.list.status", { defaultValue: "Status" })}
          value={statusF}
          onChange={(v) => setStatusF(v as Liveness | "")}
          options={[
            ["", t("devices.list.allStatus", { defaultValue: "All status" })],
            ["online", t("devices.health.online", { defaultValue: "Online" })],
            ["waiting", t("devices.list.waiting", { defaultValue: "Not reporting yet" })],
            ["unreachable", t("devices.health.unreachable", { defaultValue: "Unreachable" })],
          ]}
        />
        <FilterSelect
          label={t("devices.list.brand", { defaultValue: "Brand" })}
          value={brandF}
          onChange={setBrandF}
          options={[
            ["", t("devices.list.allBrands", { defaultValue: "All brands" })],
            ...brandsInUse.map((o) => [o.value, o.label] as [string, string]),
          ]}
        />
        <ResetButton active={filtersOn} label={t("devices.list.reset", { defaultValue: "Reset" })} onClick={resetFilters} />
        <ViewToggle
          value={view}
          onChange={setView}
          listLabel={t("devices.list.viewList", { defaultValue: "List view" })}
          gridLabel={t("devices.list.viewGrid", { defaultValue: "Grid view" })}
        />
      </Toolbar>

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

      <div className="card" style={{ padding: 12 }}>
        {list.isLoading ? (
          view === "grid" ? <SkeletonGrid count={3} minWidth={420} /> : <SkeletonTable rows={4} cols={6} />
        ) : filtered.length === 0 ? (
          <DevicesEmptyState
            hasDevices={items.length > 0}
            q={q.trim()}
            statusF={statusF}
            brandF={brandF}
            onClear={resetFilters}
            onAdd={openAdd}
          />
        ) : (
          <>
            {view === "grid" ? (
              <CardGrid minWidth={420}>
                {filtered.map((d) => {
                  const state = livenessOf(d);
                  const subtitle = deviceSubtitle([d.location, d.reported_device_name]);
                  return (
                    <div
                      key={d.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailTarget(d)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setDetailTarget(d);
                      }}
                      style={{ ...gridCardStyle, padding: 20, gap: 16, cursor: "pointer" }}
                    >
                      {/* Header: device art, identity, brand, menu */}
                      <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                        <div
                          style={{
                            width: 104,
                            height: 104,
                            flex: "0 0 104px",
                            borderRadius: 16,
                            background: "linear-gradient(160deg, color-mix(in oklab, var(--accent-soft) 85%, white), var(--accent-soft))",
                            display: "grid",
                            placeItems: "center",
                            position: "relative",
                          }}
                        >
                          <TerminalArt size={78} />
                          <span aria-hidden style={{ position: "absolute", right: 6, bottom: 6, width: 12, height: 12, borderRadius: "50%", background: HEALTH[state].dot, border: "2px solid var(--bg-elev)" }} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                            <div style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 18, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</div>
                            <BrandLogo brand={driverLabel(d.driver)} size={28} />
                            <KebabMenu
                              label={t("devices.list.moreActions", { defaultValue: "More actions" })}
                              items={[
                                { label: t("devices.page.showUrl", { defaultValue: "Show push URL" }), icon: <Icon name="clipboard" size={13} />, onClick: () => setSetupTarget(d) },
                                { label: t("common.edit"), icon: <Icon name="edit" size={13} />, onClick: () => openEdit(d) },
                                { label: t("common.delete"), icon: <Icon name="trash" size={13} />, onClick: () => setDeleteTarget(d), danger: true },
                              ]}
                            />
                          </div>
                          {subtitle && <div className="text-sm text-dim" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{subtitle}</div>}
                          {(d.model || d.serial_number) && (
                            <div className="text-sm text-dim mono" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.model || d.serial_number}</div>
                          )}
                          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
                            <HealthPill state={state} />
                            {d.clock_suspect && (
                              <span
                                className="text-sm"
                                title={t("devices.page.clockHint", { defaultValue: "The terminal reported an implausible timestamp — set its clock via NTP." })}
                                style={{ color: "var(--warning-text)", display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 500 }}
                              >
                                <Icon name="clock" size={14} />
                                {t("devices.page.clockSuspect", { defaultValue: "clock not set" })}
                              </span>
                            )}
                            {!d.last_event_at && (
                              <button
                                className="btn btn-sm"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSetupTarget(d);
                                }}
                              >
                                {t("devices.page.setUp", { defaultValue: "Set up →" })}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      <DeviceMethods device={d} large />

                      {/* People + last seen */}
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr auto 1fr",
                          alignItems: "center",
                          gap: 16,
                          padding: "14px 16px",
                          borderRadius: 12,
                          background: "var(--bg-sunken)",
                          border: "1px solid var(--border)",
                        }}
                      >
                        <BigFact
                          icon={<Icon name="users" size={20} />}
                          label={t("devices.page.colPeople", { defaultValue: "People" })}
                          value={String(d.users_total)}
                          hint={
                            d.users_unmapped > 0
                              ? t("devices.page.unmappedCount", { count: d.users_unmapped, defaultValue: `${d.users_unmapped} unmapped` })
                              : t("devices.list.peopleSeen", { defaultValue: "people seen" })
                          }
                          hintTone={d.users_unmapped > 0 ? "warn" : undefined}
                        />
                        <span aria-hidden style={{ width: 1, alignSelf: "stretch", background: "var(--border)" }} />
                        <BigFact
                          icon={<Icon name="clock" size={20} />}
                          label={t("devices.page.colLastSeen", { defaultValue: "Last seen" })}
                          value={d.last_event_at ? <RelativeTime iso={d.last_event_at} /> : t("devices.page.never", { defaultValue: "never" })}
                          hint={t("devices.list.lastEventHint", { defaultValue: "Last successful event" })}
                        />
                      </div>

                      {/* Footer actions */}
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr", alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 12 }}
                      >
                        <FooterAction icon="eye" label={t("devices.list.viewDetails", { defaultValue: "View details" })} onClick={() => setDetailTarget(d)} />
                        <span aria-hidden style={{ width: 1, height: 18, background: "var(--border)" }} />
                        <FooterAction icon="edit" label={t("common.edit")} onClick={() => openEdit(d)} />
                        <span aria-hidden style={{ width: 1, height: 18, background: "var(--border)" }} />
                        <FooterAction icon="trash" label={t("common.delete")} onClick={() => setDeleteTarget(d)} danger />
                      </div>
                    </div>
                  );
                })}
              </CardGrid>
            ) : (
            <table className="table">
              <thead>
                <tr style={{ background: "var(--bg-sunken)" }}>
                  <th>{t("devices.page.colName", { defaultValue: "Device" })}</th>
                  <th>{t("devices.list.colBrand", { defaultValue: "Brand / model" })}</th>
                  <th>{t("devices.list.colMethods", { defaultValue: "Verification" })}</th>
                  <th>{t("devices.page.colStatus", { defaultValue: "Status" })}</th>
                  <th>{t("devices.page.colPeople", { defaultValue: "People" })}</th>
                  {/* last_event_at is arrival time of the last POST (keepalives
                      included), not the device-reported tap time. */}
                  <th>{t("devices.page.colLastSeen", { defaultValue: "Last seen" })}</th>
                  <th style={{ textAlign: "end" }}>{t("devices.page.colActions", { defaultValue: "Actions" })}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => {
                  const subtitle = deviceSubtitle([d.location, d.reported_device_name, d.serial_number]);
                  const state = livenessOf(d);
                  return (
                    <tr key={d.id} onClick={() => setDetailTarget(d)} style={{ cursor: "pointer" }}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <TerminalBadge state={state} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{d.name}</div>
                            {subtitle && <div className="text-xs text-dim">{subtitle}</div>}
                          </div>
                        </div>
                      </td>
                      <td>
                        <div title={driverLabel(d.driver)} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
                          <BrandLogo brand={driverLabel(d.driver)} size={30} />
                          {(d.model || d.firmware) && (
                            <span className="text-xs text-dim mono" style={{ whiteSpace: "nowrap" }}>
                              {[d.model, d.firmware ? `fw ${d.firmware}` : null].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </div>
                      </td>
                      <td>
                        <DeviceMethods device={d} />
                      </td>
                      <td>
                        <HealthPill state={state} />
                        {state === "online" && d.last_event_at && (
                          <div className="text-xs text-dim" style={{ marginTop: 4 }}>
                            <RelativeTime iso={d.last_event_at} />
                          </div>
                        )}
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
                              {t("devices.page.setUp", { defaultValue: "Set up →" })}
                            </button>
                          </div>
                        )}
                        {d.clock_suspect && (
                          <div
                            className="text-xs"
                            style={{ marginTop: 5, color: "var(--warning-text)", display: "flex", alignItems: "center", gap: 4, fontWeight: 600 }}
                            title={t("devices.page.clockHint", {
                              defaultValue: "The terminal reported an implausible timestamp — set its clock via NTP.",
                            })}
                          >
                            <Icon name="clock" size={11} />
                            {t("devices.page.clockSuspect", { defaultValue: "clock not set" })}
                          </div>
                        )}
                      </td>
                      <td>
                        {d.users_total === 0 ? (
                          <span className="text-xs text-dim">{t("devices.page.noPeople", { defaultValue: "nobody seen yet" })}</span>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                              <Icon name="users" size={13} />
                              <span className="mono">{d.users_total}</span>
                            </span>
                            {d.users_unmapped > 0 && (
                              <span className="pill pill-warning">
                                {t("devices.page.unmappedCount", { count: d.users_unmapped, defaultValue: `${d.users_unmapped} unmapped` })}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="text-sm text-dim" style={{ whiteSpace: "nowrap" }}>
                        {d.last_event_at ? <RelativeTime iso={d.last_event_at} /> : t("devices.page.never", { defaultValue: "never" })}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div className="row-actions" style={{ justifyContent: "flex-end", width: "100%" }}>
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => setSetupTarget(d)}
                            title={t("devices.page.showUrl", { defaultValue: "Show push URL" })}
                            aria-label={t("devices.page.showUrl", { defaultValue: "Show push URL" })}
                          >
                            <Icon name="clipboard" size={13} />
                          </button>
                          <button className="btn btn-sm btn-ghost" onClick={() => openEdit(d)} title={t("common.edit")} aria-label={t("common.edit")}>
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
            )}
            <div className="text-sm text-dim" style={{ padding: "14px 6px 4px" }}>
              {t("devices.list.showing", {
                shown: filtered.length,
                total: items.length,
                defaultValue: `Showing ${filtered.length} of ${items.length} devices · click a device to see its events and people`,
              })}
            </div>
          </>
        )}
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

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function driverLabel(driver: string): string {
  const o = DRIVER_OPTIONS.find((x) => x.value === driver);
  // "Hikvision (ISAPI)" → "Hikvision" in the table; the drawer keeps the full label.
  return o ? o.label.replace(/\s*\(.*\)$/, "") : driver;
}

const HEALTH: Record<Liveness, { dot: string; bg: string; fg: string; key: string; fallback: string }> = {
  online: { dot: "var(--success)", bg: "var(--success-soft)", fg: "var(--success-text)", key: "devices.health.online", fallback: "Online" },
  unreachable: { dot: "var(--danger)", bg: "var(--danger-soft)", fg: "var(--danger-text)", key: "devices.health.unreachable", fallback: "Unreachable" },
  waiting: { dot: "var(--text-tertiary)", bg: "var(--bg-sunken)", fg: "var(--text-secondary)", key: "devices.health.waiting", fallback: "No events yet" },
};

function HealthPill({ state }: { state: Liveness }) {
  const { t } = useTranslation();
  const h = HEALTH[state];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "3px 10px",
        borderRadius: 8,
        background: h.bg,
        color: h.fg,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", background: h.dot }} />
      {t(h.key, { defaultValue: h.fallback })}
    </span>
  );
}

/** Terminal tile: a fingerprint mark on a tinted square, with a small
 *  status dot so the row reads at a glance. */
function TerminalBadge({ state }: { state: Liveness }) {
  const h = HEALTH[state];
  return (
    <span aria-hidden style={{ position: "relative", width: 42, height: 42, flex: "0 0 42px" }}>
      <span
        style={{
          width: 42,
          height: 42,
          borderRadius: 11,
          display: "grid",
          placeItems: "center",
          background: "var(--accent-soft)",
          color: "var(--accent)",
        }}
      >
        <FingerprintIcon size={22} />
      </span>
      <span
        style={{
          position: "absolute",
          right: -2,
          bottom: -2,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: h.dot,
          border: "2px solid var(--bg-elev)",
        }}
      />
    </span>
  );
}

function FingerprintIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    </svg>
  );
}

type Method = "face" | "fingerprint" | "card" | "pin";

/** Methods the terminal accepts, read from the verify mode on its recent
 *  scans (``faceOrFpOrCardOrPw`` → face, fingerprint, card, PIN). Nothing
 *  is shown until the terminal has sent a scan — we don't guess. */
function methodsFrom(modes: Array<string | null>): Method[] {
  const found = new Set<Method>();
  for (const m of modes) {
    if (!m) continue;
    for (const raw of m.split(/Or|And/)) {
      const p = raw.trim().toLowerCase();
      if (p === "face") found.add("face");
      else if (p === "fp" || p === "fingerprint" || p === "finger") found.add("fingerprint");
      else if (p === "card") found.add("card");
      else if (p === "pw" || p === "pin" || p === "password") found.add("pin");
    }
  }
  return (["face", "fingerprint", "card", "pin"] as Method[]).filter((x) => found.has(x));
}

function DeviceMethods({ device, large = false }: { device: Device; large?: boolean }) {
  const { t } = useTranslation();
  const events = useDeviceEvents(device.last_event_at ? device.id : null);
  const methods = methodsFrom((events.data?.items ?? []).map((e) => e.verify_mode));
  if (methods.length === 0) {
    return (
      <span className="text-xs text-dim">
        {device.last_event_at
          ? "—"
          : t("devices.list.methodsPending", { defaultValue: "after first scan" })}
      </span>
    );
  }
  return (
    <span style={{ display: "flex", gap: large ? 8 : 6, flexWrap: "wrap" }}>
      {methods.map((m) => (
        <MethodChip key={m} method={m} large={large} />
      ))}
    </span>
  );
}

const METHOD_LABEL: Record<Method, { key: string; fallback: string }> = {
  face: { key: "devices.verify.face", fallback: "Face" },
  fingerprint: { key: "devices.verify.fingerprint", fallback: "Fingerprint" },
  card: { key: "devices.verify.card", fallback: "Card" },
  pin: { key: "devices.verify.pin", fallback: "PIN" },
};

function MethodChip({ method, large = false }: { method: Method; large?: boolean }) {
  const { t } = useTranslation();
  const label = t(METHOD_LABEL[method].key, { defaultValue: METHOD_LABEL[method].fallback });
  const primary = method === "face" || method === "fingerprint";
  return (
    <span
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: large ? 7 : 5,
        padding: large ? "7px 11px" : "3px 9px",
        borderRadius: large ? 10 : 999,
        fontSize: large ? 13 : 11.5,
        fontWeight: 600,
        whiteSpace: "nowrap",
        background: primary ? "var(--accent-soft)" : "var(--bg-sunken)",
        color: primary ? "var(--accent-text, var(--accent))" : "var(--text-secondary)",
        border: `1px solid ${primary ? "color-mix(in oklab, var(--accent) 30%, transparent)" : "var(--border)"}`,
      }}
    >
      <MethodIcon method={method} size={large ? 15 : 13} />
      {label}
    </span>
  );
}

function MethodIcon({ method, size = 13 }: { method: Method; size?: number }) {
  if (method === "fingerprint") return <FingerprintIcon size={size} />;
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (method === "face")
    return (
      <svg {...common}>
        <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
        <path d="M8.5 14.5s1.3 1.5 3.5 1.5 3.5-1.5 3.5-1.5M9 9.5h.01M15 9.5h.01" />
      </svg>
    );
  if (method === "card")
    return (
      <svg {...common}>
        <rect x="2.5" y="5" width="19" height="14" rx="2" />
        <path d="M2.5 10h19M6 15h4" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" />
    </svg>
  );
}

function BigFact({
  icon,
  label,
  value,
  hint,
  hintTone,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint: string;
  hintTone?: "warn" | undefined;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
      <span aria-hidden style={{ width: 46, height: 46, flex: "0 0 46px", borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent)", display: "grid", placeItems: "center" }}>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="text-sm text-dim">{label}</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", lineHeight: 1.3 }}>{value}</div>
        <div className="text-sm" style={{ color: hintTone === "warn" ? "var(--warning-text)" : "var(--text-tertiary)" }}>{hint}</div>
      </div>
    </div>
  );
}

function FooterAction({ icon, label, onClick, danger = false }: { icon: "eye" | "edit" | "trash"; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: "none",
        border: "none",
        background: "transparent",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: "8px 6px",
        borderRadius: 8,
        fontSize: 14,
        fontWeight: 600,
        fontFamily: "inherit",
        color: danger ? "var(--danger-text)" : "var(--text)",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = danger ? "var(--danger-soft)" : "var(--bg-sunken)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <Icon name={icon} size={16} />
      {label}
    </button>
  );
}

const DEVICE_ICON = {
  total: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M10 18.5h4M9.5 9.5a2.5 2.5 0 0 1 5 0v2M12 9v4" />
    </>
  ),
  online: (
    <>
      <path d="M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" />
      <circle cx="12" cy="19.5" r="1" fill="currentColor" />
    </>
  ),
  waiting: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  unreachable: (
    <>
      <path d="M2 9a15 15 0 0 1 6-3.5M22 9a15 15 0 0 0-9-4M5 12.5a10 10 0 0 1 3-2M19 12.5a10 10 0 0 0-3-2M8.5 16a5 5 0 0 1 7 0M3 3l18 18" />
    </>
  ),
};

/** Empty state that follows whatever produced it. */
function DevicesEmptyState({
  hasDevices,
  q,
  statusF,
  brandF,
  onClear,
  onAdd,
}: {
  hasDevices: boolean;
  q: string;
  statusF: Liveness | "";
  brandF: string;
  onClear: () => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  if (!hasDevices) {
    return (
      <EmptyPanel
        tone="accent"
        icon={<FingerprintIcon size={32} />}
        title={t("devices.page.emptyTitle", { defaultValue: "No devices yet" })}
        body={t("devices.page.empty", {
          defaultValue:
            "Register a terminal here, then paste the push URL we generate into the device. It starts reporting the moment someone uses it.",
        })}
        actions={
          <button className="btn btn-primary" onClick={onAdd}>
            <Icon name="plus" size={12} />
            {t("devices.page.addDevice", { defaultValue: "Add device" })}
          </button>
        }
      />
    );
  }
  const onlyStatus = !!statusF && !q && !brandF;
  const clear = (
    <button type="button" className="btn" onClick={onClear}>
      <Icon name="refresh" size={12} />
      {onlyStatus
        ? t("devices.list.showAll", { defaultValue: "Show all devices" })
        : t("devices.list.clearFilters", { defaultValue: "Clear filters" })}
    </button>
  );
  if (onlyStatus) {
    const msg: Record<Liveness, { title: string; body: string }> = {
      online: {
        title: t("devices.list.emptyOnlineTitle", { defaultValue: "No devices are online right now" }),
        body: t("devices.list.emptyOnlineBody", { defaultValue: "None of your terminals has sent an event recently. Check the Unreachable and Not reporting cards." }),
      },
      waiting: {
        title: t("devices.list.emptyWaitingTitle", { defaultValue: "Every device is reporting" }),
        body: t("devices.list.emptyWaitingBody", { defaultValue: "All terminals have sent at least one event." }),
      },
      unreachable: {
        title: t("devices.list.emptyUnreachableTitle", { defaultValue: "No devices are unreachable" }),
        body: t("devices.list.emptyUnreachableBody", { defaultValue: "Good news: every terminal that has reported is still in touch." }),
      },
    };
    return (
      <EmptyPanel
        tone={statusF === "online" ? "warning" : "success"}
        icon={<Icon name={statusF === "online" ? "activity" : "check"} size={30} />}
        title={msg[statusF].title}
        body={msg[statusF].body}
        actions={clear}
      />
    );
  }
  if (q && !statusF && !brandF) {
    return (
      <EmptyPanel
        icon={<Icon name="search" size={28} />}
        title={t("devices.list.emptySearchTitle", { q, defaultValue: `No results for “${q}”` })}
        body={t("devices.list.emptySearchBody", { defaultValue: "Check the spelling, or search by device name, location, serial number or model." })}
        actions={clear}
      />
    );
  }
  return (
    <EmptyPanel
      icon={<Icon name="filter" size={28} />}
      title={t("devices.list.emptyFiltersTitle", { defaultValue: "No devices match these filters" })}
      body={t("devices.list.emptyFiltersBody", { defaultValue: "Try removing one of the filters, or clear them to see every device." })}
      actions={clear}
    />
  );
}
