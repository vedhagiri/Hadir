// Device detail drawer — opens when an operator clicks a device row.
//
// Two tabs, matching the two questions an operator actually has:
//   1. "Is it sending anything?"  → Incoming events (raw taps, newest first)
//   2. "Who are these people?"    → Map to employees
//
// The mapping tab is load-bearing. A push device never exposes a user list,
// so its people are discovered from the events themselves; taps that arrive
// before a mapping exists are held rather than dropped, and mapping replays
// them into attendance.

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { DrawerShell } from "../../components/DrawerShell";
import { Icon } from "../../shell/Icon";
import { useEmployeeList } from "../employees/hooks";
import {
  useAutoMapDeviceUsers,
  useDeviceEvents,
  useDeviceUsers,
  useMapDeviceUser,
} from "./hooks";
import type { Device, DeviceEvent, DeviceUser } from "./types";

interface Props {
  device: Device;
  onClose: () => void;
  onShowSetup: () => void;
}

type Tab = "events" | "people";

export function DeviceDetailDrawer({ device, onClose, onShowSetup }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("events");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const events = useDeviceEvents(device.id);
  const users = useDeviceUsers(device.id);

  const unmappedCount = useMemo(
    () => (users.data?.items ?? []).filter((u) => u.employee_id === null).length,
    [users.data],
  );

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer" style={{ width: "min(820px, 96vw)" }}>
        <div className="drawer-head">
          <div style={{ flex: 1 }}>
            <div className="mono text-xs text-dim">
              {t("devices.label", { defaultValue: "DEVICE" })}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>
              {device.name}
            </div>
            <div className="text-xs text-dim">
              {device.location || "—"}
              {device.reported_device_name
                ? ` · ${device.reported_device_name}`
                : ""}
            </div>
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* Hardware facts, learned from the events themselves. */}
        <div
          style={{
            display: "flex",
            gap: 22,
            flexWrap: "wrap",
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-sunken)",
          }}
        >
          <Meta
            label={t("devices.fields.serial", { defaultValue: "Serial" })}
            value={device.serial_number}
          />
          <Meta
            label={t("devices.fields.model", { defaultValue: "Model" })}
            value={device.model}
          />
          <Meta
            label={t("devices.detail.lastEvent", { defaultValue: "Last event" })}
            value={
              device.last_event_at
                ? new Date(device.last_event_at).toLocaleString()
                : t("devices.page.never", { defaultValue: "never" })
            }
          />
          <div style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={onShowSetup}>
            <Icon name="clipboard" size={12} />
            {t("devices.detail.showUrl", { defaultValue: "Show push URL" })}
          </button>
        </div>

        {device.clock_suspect && (
          <Banner tone="warn">
            {t("devices.detail.clockSuspect", {
              defaultValue:
                "This terminal reported a timestamp we could not believe (usually an unset clock). Those taps were recorded using their arrival time. Set the device clock via NTP.",
            })}
          </Banner>
        )}

        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "0 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <TabButton
            active={tab === "events"}
            onClick={() => setTab("events")}
            label={t("devices.detail.tabEvents", {
              defaultValue: "Incoming events",
            })}
            count={events.data?.items.length ?? 0}
          />
          <TabButton
            active={tab === "people"}
            onClick={() => setTab("people")}
            label={t("devices.detail.tabPeople", {
              defaultValue: "Map to employees",
            })}
            count={unmappedCount}
            danger={unmappedCount > 0}
          />
        </div>

        <div className="drawer-body">
          {msg && <Banner tone="ok">{msg}</Banner>}
          {error && <Banner tone="danger">{error}</Banner>}

          {tab === "events" ? (
            <EventsTab
              items={events.data?.items ?? []}
              loading={events.isLoading}
            />
          ) : (
            <PeopleTab
              device={device}
              items={users.data?.items ?? []}
              loading={users.isLoading}
              onMessage={(m) => {
                setMsg(m);
                setError(null);
              }}
              onError={(e) => {
                setError(e);
                setMsg(null);
              }}
            />
          )}
        </div>
      </div>
    </DrawerShell>
  );
}

// --- events -----------------------------------------------------------------

function EventsTab({
  items,
  loading,
}: {
  items: DeviceEvent[];
  loading: boolean;
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="text-sm text-dim" style={{ padding: 16 }}>
        {t("devices.detail.loadingEvents", { defaultValue: "Loading events…" })}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        title={t("devices.detail.noEventsTitle", {
          defaultValue: "Waiting for the first event",
        })}
        body={t("devices.detail.noEventsBody", {
          defaultValue:
            "Nothing has arrived from this terminal yet. Check that the push URL is saved on the device and that it can reach the server.",
        })}
      />
    );
  }

  return (
    <div className="tablewrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t("devices.detail.colTime", { defaultValue: "Time" })}</th>
            <th>
              {t("devices.detail.colEmployeeNo", {
                defaultValue: "Employee no.",
              })}
            </th>
            <th>{t("devices.detail.colName", { defaultValue: "Name on device" })}</th>
            <th>{t("devices.detail.colVerify", { defaultValue: "Verify" })}</th>
            <th>{t("devices.detail.colSerial", { defaultValue: "Serial" })}</th>
            <th>{t("devices.detail.colResult", { defaultValue: "Result" })}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td className="mono text-xs">
                {new Date(e.occurred_at).toLocaleString()}
              </td>
              <td className="mono text-xs">{e.device_user_id}</td>
              <td>{e.person_name ?? <span className="text-dim">—</span>}</td>
              <td className="text-xs">{e.verify_mode ?? "—"}</td>
              <td className="mono text-xs">{e.event_serial || "—"}</td>
              <td>
                <EventStatus event={e} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EventStatus({ event }: { event: DeviceEvent }) {
  const { t } = useTranslation();
  if (event.clock_suspect) {
    return (
      <span className="pill pill-warning">
        {t("devices.detail.statusClock", { defaultValue: "Clock corrected" })}
      </span>
    );
  }
  if (event.status === "skipped") {
    return (
      <span className="pill pill-warning">
        {t("devices.detail.statusHeld", { defaultValue: "Held · unmapped" })}
      </span>
    );
  }
  if (event.status === "failed") {
    return (
      <span className="pill pill-danger">
        {t("devices.detail.statusFailed", { defaultValue: "Failed" })}
      </span>
    );
  }
  if (event.status === "processed") {
    return (
      <span className="pill pill-success">
        {t("devices.detail.statusAttendance", { defaultValue: "Attendance" })}
      </span>
    );
  }
  return (
    <span className="pill pill-neutral">
      {t("devices.detail.statusPending", { defaultValue: "Pending" })}
    </span>
  );
}

// --- people -----------------------------------------------------------------

function PeopleTab({
  device,
  items,
  loading,
  onMessage,
  onError,
}: {
  device: Device;
  items: DeviceUser[];
  loading: boolean;
  onMessage: (m: string) => void;
  onError: (e: string) => void;
}) {
  const { t } = useTranslation();
  const map = useMapDeviceUser(device.id);
  const autoMap = useAutoMapDeviceUsers(device.id);
  const [picked, setPicked] = useState<Record<string, string>>({});

  // Admin-only screen, so the unrestricted employee list is the right
  // source for the picker.
  const employees = useEmployeeList({
    q: "",
    department_id: null,
    include_inactive: false,
    page: 1,
    page_size: 500,
  });
  const employeeOptions = employees.data?.items ?? [];

  const mapped = items.filter((u) => u.employee_id !== null).length;
  const unmapped = items.length - mapped;
  const held = items
    .filter((u) => u.employee_id === null)
    .reduce((a, u) => a + u.taps_count, 0);

  const doMap = async (deviceUserId: string) => {
    const raw = picked[deviceUserId];
    if (!raw) {
      onError(
        t("devices.detail.pickFirst", {
          defaultValue: "Pick an employee first.",
        }),
      );
      return;
    }
    try {
      const res = await map.mutateAsync({
        deviceUserId,
        employeeId: Number(raw),
      });
      onMessage(
        res.replayed > 0
          ? t("devices.detail.mappedWithReplay", {
              count: res.replayed,
              defaultValue: `Mapped. ${res.replayed} held tap(s) replayed — attendance recalculated.`,
            })
          : t("devices.detail.mapped", { defaultValue: "Mapped." }),
      );
    } catch (err) {
      onError(
        extractApiError(
          err,
          t("devices.errors.mapFailed", {
            defaultValue: "Could not map this person.",
          }),
        ),
      );
    }
  };

  const doAutoMap = async () => {
    try {
      const res = await autoMap.mutateAsync();
      onMessage(
        res.mapped > 0
          ? t("devices.detail.autoMapped", {
              mapped: res.mapped,
              replayed: res.replayed,
              defaultValue: `${res.mapped} matched by employee code, ${res.replayed} held tap(s) replayed.`,
            })
          : t("devices.detail.autoMappedNone", {
              defaultValue:
                "No further device IDs match an employee code — map these by hand.",
            }),
      );
    } catch (err) {
      onError(
        extractApiError(
          err,
          t("devices.errors.autoMapFailed", {
            defaultValue: "Auto-map failed.",
          }),
        ),
      );
    }
  };

  if (loading) {
    return (
      <div className="text-sm text-dim" style={{ padding: 16 }}>
        {t("devices.detail.loadingPeople", { defaultValue: "Loading people…" })}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title={t("devices.detail.noPeopleTitle", {
          defaultValue: "Nobody seen yet",
        })}
        body={t("devices.detail.noPeopleBody", {
          defaultValue:
            "People appear here the first time they use the terminal — this device has no user list to sync, because it connects to us rather than the other way round.",
        })}
      />
    );
  }

  return (
    <>
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 12,
        }}
      >
        <Tile
          n={items.length}
          label={t("devices.detail.tilePeople", { defaultValue: "People seen" })}
        />
        <Tile
          n={mapped}
          label={t("devices.detail.tileMapped", { defaultValue: "Mapped" })}
          tone="ok"
        />
        <Tile
          n={unmapped}
          label={t("devices.detail.tileUnmapped", { defaultValue: "Unmapped" })}
          {...(unmapped > 0 ? { tone: "warn" as const } : {})}
        />
        <Tile
          n={held}
          label={t("devices.detail.tileHeld", { defaultValue: "Taps held" })}
        />
      </div>

      <div className="tablewrap">
        <table className="table">
          <thead>
            <tr>
              <th>
                {t("devices.detail.colDeviceId", { defaultValue: "Device ID" })}
              </th>
              <th>
                {t("devices.detail.colName", { defaultValue: "Name on device" })}
              </th>
              <th style={{ textAlign: "end", width: 60 }}>
                {t("devices.detail.colTaps", { defaultValue: "Taps" })}
              </th>
              <th>
                {t("devices.detail.colEmployee", {
                  defaultValue: "Maugood employee",
                })}
              </th>
              <th style={{ width: 110 }}>
                {t("devices.page.colStatus", { defaultValue: "Status" })}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => (
              <tr key={u.id}>
                <td className="mono text-xs" style={{ fontWeight: 600 }}>
                  {u.device_user_id}
                </td>
                <td>
                  {u.name ?? (
                    <span className="text-dim text-xs">
                      {t("devices.detail.noName", { defaultValue: "not sent" })}
                    </span>
                  )}
                </td>
                <td
                  className="mono text-xs"
                  style={{ textAlign: "end", fontVariantNumeric: "tabular-nums" }}
                >
                  {u.taps_count}
                </td>
                <td>
                  {u.employee_id !== null ? (
                    <div>
                      <div style={{ fontWeight: 600 }}>{u.employee_name}</div>
                      <div className="text-xs text-dim mono">
                        {u.employee_code}
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <select
                        value={picked[u.device_user_id] ?? ""}
                        onChange={(e) =>
                          setPicked((p) => ({
                            ...p,
                            [u.device_user_id]: e.target.value,
                          }))
                        }
                        aria-label={t("devices.detail.pickEmployee", {
                          defaultValue: "Select employee",
                        })}
                        style={{
                          padding: "5px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-sm)",
                          background: "var(--bg)",
                          color: "var(--text)",
                          fontSize: 12.5,
                          maxWidth: 220,
                        }}
                      >
                        <option value="">
                          {t("devices.detail.selectEmployee", {
                            defaultValue: "Select employee…",
                          })}
                        </option>
                        {employeeOptions.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.full_name} ({e.employee_code})
                          </option>
                        ))}
                      </select>
                      <button
                        className="btn btn-sm"
                        onClick={() => doMap(u.device_user_id)}
                        disabled={map.isPending}
                      >
                        {t("devices.detail.map", { defaultValue: "Map" })}
                      </button>
                    </div>
                  )}
                </td>
                <td>
                  {u.employee_id !== null ? (
                    <span className="pill pill-success">
                      {t("devices.detail.statusMapped", {
                        defaultValue: "Mapped",
                      })}
                    </span>
                  ) : (
                    <span className="pill pill-warning">
                      {t("devices.detail.statusUnmapped", {
                        defaultValue: "Unmapped",
                      })}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginTop: 12,
          flexWrap: "wrap",
        }}
      >
        <button
          className="btn btn-sm"
          onClick={doAutoMap}
          disabled={autoMap.isPending || unmapped === 0}
        >
          <Icon name="zap" size={12} />
          {t("devices.detail.autoMap", {
            defaultValue: "Auto-map by employee code",
          })}
        </button>
        <div style={{ flex: 1 }} />
        <span className="text-xs text-dim">
          {unmapped > 0
            ? t("devices.detail.stillUnmapped", {
                count: unmapped,
                defaultValue: `${unmapped} people still unmapped`,
              })
            : t("devices.detail.allMapped", { defaultValue: "Everyone mapped" })}
        </span>
      </div>

      <div
        style={{
          marginTop: 14,
          padding: "10px 12px",
          background: "var(--bg-sunken)",
          borderRadius: "var(--radius-sm)",
          fontSize: 12,
          color: "var(--text-secondary)",
          display: "flex",
          gap: 10,
        }}
      >
        <Icon name="info" size={13} />
        <span>
          {t("devices.detail.neverAutoCreate", {
            defaultValue:
              "Maugood never creates an employee from a device. An unrecognised ID is held, not enrolled — add the person in Employees first, then map them here and their earlier taps are replayed.",
          })}
        </span>
      </div>
    </>
  );
}

// --- small shared bits -------------------------------------------------------

function TabButton({
  active,
  onClick,
  label,
  count,
  danger = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        background: "none",
        border: 0,
        padding: "10px 12px",
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        color: active ? "var(--accent-text, var(--text))" : "var(--text-secondary)",
        borderBottom: `2px solid ${active ? "var(--accent, var(--text))" : "transparent"}`,
        marginBottom: -1,
      }}
    >
      {label}
      {count > 0 && (
        <span
          className={danger ? "pill pill-warning" : "pill pill-neutral"}
          style={{ marginInlineStart: 6 }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

function Meta({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="text-xs text-dim">{label}</div>
      <div className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
        {value ?? "—"}
      </div>
    </div>
  );
}

function Tile({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone?: "ok" | "warn";
}) {
  const color =
    tone === "ok"
      ? "var(--success-text, var(--text))"
      : tone === "warn"
        ? "var(--warning-text, var(--text))"
        : "var(--text)";
  return (
    <div
      style={{
        flex: "1 1 110px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-sm)",
        padding: "10px 12px",
        background: "var(--bg-sunken)",
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1.15 }}>
        {n}
      </div>
      <div className="text-xs text-dim">{label}</div>
    </div>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "danger";
  children: React.ReactNode;
}) {
  const bg =
    tone === "danger"
      ? "var(--danger-soft)"
      : tone === "warn"
        ? "var(--warning-soft, var(--bg-sunken))"
        : "var(--success-soft, var(--bg-sunken))";
  const fg =
    tone === "danger"
      ? "var(--danger-text)"
      : tone === "warn"
        ? "var(--warning-text, var(--text))"
        : "var(--text)";
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      style={{
        background: bg,
        color: fg,
        padding: "9px 12px",
        borderRadius: "var(--radius-sm)",
        fontSize: 12.5,
        margin: "0 0 12px",
      }}
    >
      {children}
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ padding: "28px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
        {title}
      </div>
      <div
        className="text-sm text-dim"
        style={{ maxWidth: "46ch", margin: "0 auto" }}
      >
        {body}
      </div>
    </div>
  );
}
