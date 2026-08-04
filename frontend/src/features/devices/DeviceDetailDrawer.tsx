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

import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { extractApiError } from "../../api/client";
import { DrawerShell } from "../../components/DrawerShell";
import { RelativeTime } from "../../components/RelativeTime";
import { Icon } from "../../shell/Icon";
import { useTenantDateTime } from "../../util/datetime";
import { useEmployeeList } from "../employees/hooks";
import { StatusPill } from "./DeviceStatus";
import { deviceSubtitle, verifyModeLabel } from "./format";
import {
  useAutoMapDeviceUsers,
  useDeviceEvents,
  useDeviceUsers,
  useMapDeviceUser,
  useResyncDevice,
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
  const resync = useResyncDevice(device.id);

  const runResync = async () => {
    setError(null);
    setMsg(null);
    try {
      const r = await resync.mutateAsync();
      // Report the real outcome, including "nothing was stuck" — a silent
      // success is indistinguishable from a broken button.
      const moved = r.adopted + r.retried + r.processed;
      setMsg(
        moved === 0
          ? r.still_unmapped > 0
            ? t("devices.resync.onlyUnmapped", {
                count: r.still_unmapped,
                defaultValue: `Nothing to sync — ${r.still_unmapped} tap(s) are waiting for their person to be mapped.`,
              })
            : t("devices.resync.upToDate", {
                defaultValue: "Already up to date — nothing was waiting.",
              })
          : t("devices.resync.done", {
              processed: r.processed,
              adopted: r.adopted,
              retried: r.retried,
              defaultValue: `Synced — ${r.processed} tap(s) written to attendance (${r.adopted} newly mapped, ${r.retried} retried).`,
            }),
      );
    } catch (err) {
      setError(
        extractApiError(
          err,
          t("devices.resync.failed", { defaultValue: "Sync failed." }),
        ),
      );
    }
  };

  const unmappedCount = useMemo(
    () => (users.data?.items ?? []).filter((u) => u.employee_id === null).length,
    [users.data],
  );

  // The name the operator gave it, then the name the device calls itself
  // — those differ often enough that seeing both prevents a "wrong
  // device" mix-up during setup.
  const subtitle = deviceSubtitle([device.location, device.reported_device_name]);

  return (
    <DrawerShell onClose={onClose}>
      <div className="drawer" style={{ width: "min(820px, 96vw)" }}>
        <div className="drawer-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono text-xs text-dim">
              {t("devices.label", { defaultValue: "DEVICE" })}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
                marginTop: 2,
              }}
            >
              <span style={{ fontSize: 16, fontWeight: 600 }}>
                {device.name}
              </span>
              <StatusPill device={device} />
            </div>
            {subtitle && <div className="text-xs text-dim">{subtitle}</div>}
          </div>
          <button
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        {/* Liveness + hardware facts. Serial / model are learned from the
            events themselves, so a device that hasn't reported has none —
            we omit those rather than print a row of dashes. */}
        <div
          style={{
            display: "flex",
            gap: 20,
            flexWrap: "wrap",
            alignItems: "center",
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-sunken)",
          }}
        >
          {/* Arrival time of the last POST, keepalives included — this is
              the liveness signal, NOT the newest row in the events tab
              (those carry the time the device claims the tap happened).
              Labelled "Last seen" so the two aren't read as the same
              number. */}
          <Meta
            label={t("devices.detail.lastSeen", { defaultValue: "Last seen" })}
            title={t("devices.detail.lastSeenHint", {
              defaultValue:
                "When this terminal last contacted the server, including keepalives. Event times below are what the device reported.",
            })}
          >
            {device.last_event_at ? (
              <RelativeTime iso={device.last_event_at} />
            ) : (
              t("devices.page.never", { defaultValue: "never" })
            )}
          </Meta>
          {device.serial_number && (
            <Meta
              label={t("devices.fields.serial", { defaultValue: "Serial" })}
            >
              {device.serial_number}
            </Meta>
          )}
          {device.model && (
            <Meta label={t("devices.fields.model", { defaultValue: "Model" })}>
              {device.model}
            </Meta>
          )}
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-sm"
              onClick={runResync}
              disabled={resync.isPending}
              title={t("devices.resync.hint", {
                defaultValue:
                  "Re-process taps already received that haven't become attendance yet. This does not contact the terminal — a push device can't be polled.",
              })}
            >
              <Icon name="refresh" size={12} />
              {resync.isPending
                ? t("devices.resync.running", { defaultValue: "Syncing…" })
                : t("devices.resync.action", { defaultValue: "Sync now" })}
            </button>
            <button className="btn btn-sm" onClick={onShowSetup}>
              <Icon name="clipboard" size={12} />
              {t("devices.detail.showUrl", { defaultValue: "Show push URL" })}
            </button>
          </div>
        </div>

        <div
          className="tabs"
          style={{ padding: "0 16px", marginBottom: 0, gap: 2 }}
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

          {device.clock_suspect && (
            <Banner tone="warn">
              {t("devices.detail.clockSuspect", {
                defaultValue:
                  "This terminal reported a timestamp we could not believe (usually an unset clock). Those taps were recorded using their arrival time. Set the device clock via NTP.",
              })}
            </Banner>
          )}

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

/** A tap that did not become attendance is what an operator hunts for. */
function needsAttention(e: DeviceEvent): boolean {
  return e.clock_suspect || e.status === "skipped" || e.status === "failed";
}

function EventsTab({
  items,
  loading,
}: {
  items: DeviceEvent[];
  loading: boolean;
}) {
  const { t } = useTranslation();
  const dt = useTenantDateTime();
  const [onlyProblems, setOnlyProblems] = useState(false);

  const problemCount = useMemo(
    () => items.filter(needsAttention).length,
    [items],
  );

  // The API returns taps in arrival order, but the column an operator
  // reads is the time the device says the tap happened. Those disagree
  // whenever a terminal buffers offline and posts a backlog, and the
  // result looks like a randomly-ordered list. Sort by what we display.
  const rows = useMemo(() => {
    const filtered = onlyProblems ? items.filter(needsAttention) : items;
    return [...filtered].sort((a, b) => {
      const d =
        new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
      if (d !== 0) return d;
      return new Date(b.received_at).getTime() - new Date(a.received_at).getTime();
    });
  }, [items, onlyProblems]);

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

  const today = dt.formatDate(new Date());
  const yesterday = dt.formatDate(new Date(Date.now() - 86_400_000));

  let lastDay: string | null = null;

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <div className="seg" role="group">
          <button
            className={`seg-btn${onlyProblems ? "" : " active"}`}
            aria-pressed={!onlyProblems}
            onClick={() => setOnlyProblems(false)}
          >
            {t("devices.detail.filterAll", { defaultValue: "All" })}
            <span className="text-dim">{items.length}</span>
          </button>
          <button
            className={`seg-btn${onlyProblems ? " active" : ""}`}
            aria-pressed={onlyProblems}
            onClick={() => setOnlyProblems(true)}
            disabled={problemCount === 0}
            // .seg-btn is not .btn, so it inherits no disabled styling —
            // without this the filter looks clickable when it isn't.
            style={
              problemCount === 0
                ? { opacity: 0.45, cursor: "default" }
                : undefined
            }
          >
            {t("devices.detail.filterProblems", {
              defaultValue: "Needs attention",
            })}
            <span className={problemCount > 0 ? "" : "text-dim"}>
              {problemCount}
            </span>
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <span className="text-xs text-dim">
          {t("devices.detail.timesAreDeviceReported", {
            defaultValue: "Times are what the device reported",
          })}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          {t("devices.detail.noProblems", {
            defaultValue: "Every tap became attendance — nothing needs a look.",
          })}
        </div>
      ) : (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                {/* Widths hold a 12-hour clock and the longest verify
                    combination on one line — wrapped cells double the row
                    height and make a long tap list hard to scan. */}
                <th style={{ width: 108 }}>
                  {t("devices.detail.colTime", { defaultValue: "Time" })}
                </th>
                <th>
                  {t("devices.detail.colPerson", { defaultValue: "Person" })}
                </th>
                <th style={{ width: 172 }}>
                  {t("devices.detail.colVerify", { defaultValue: "Verified by" })}
                </th>
                <th style={{ width: 130 }}>
                  {t("devices.detail.colResult", { defaultValue: "Result" })}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const day = dt.formatDate(e.occurred_at);
                const newDay = day !== lastDay;
                lastDay = day;
                const dayLabel =
                  day === today
                    ? t("devices.detail.today", { defaultValue: "Today" })
                    : day === yesterday
                      ? t("devices.detail.yesterday", {
                          defaultValue: "Yesterday",
                        })
                      : day;
                return (
                  <Fragment key={e.id}>
                    {newDay && (
                      <tr>
                        <td
                          colSpan={4}
                          style={{
                            padding: "7px 12px",
                            background: "var(--bg-sunken)",
                            fontSize: 11,
                            fontWeight: 600,
                            letterSpacing: "0.04em",
                            textTransform: "uppercase",
                            color: "var(--text-tertiary)",
                          }}
                        >
                          {dayLabel}
                          {dayLabel === day ? "" : ` · ${day}`}
                        </td>
                      </tr>
                    )}
                    <tr>
                      <td
                        className="mono text-xs"
                        style={{ whiteSpace: "nowrap" }}
                        title={t("devices.detail.arrivedAt", {
                          time: dt.formatDateTime(e.received_at),
                          defaultValue: `Arrived ${dt.formatDateTime(e.received_at)}`,
                        })}
                      >
                        {dt.formatTimeWithSeconds(e.occurred_at)}
                      </td>
                      <td>
                        <div style={{ fontWeight: 500 }}>
                          {e.person_name ?? (
                            <span className="text-dim">
                              {t("devices.detail.unknownPerson", {
                                defaultValue: "unnamed",
                              })}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-dim mono">
                          {t("devices.detail.idAndSerial", {
                            id: e.device_user_id,
                            serial: e.event_serial || "—",
                            defaultValue: `ID ${e.device_user_id} · #${e.event_serial || "—"}`,
                          })}
                        </div>
                      </td>
                      <td className="text-xs" style={{ whiteSpace: "nowrap" }}>
                        {verifyModeLabel(e.verify_mode, t)}
                      </td>
                      <td>
                        <EventStatus event={e} />
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// Every pill carries a hover explanation. "Held" and "Clock corrected"
// are Maugood vocabulary, not something an operator can be expected to
// infer from two words.
function EventStatus({ event }: { event: DeviceEvent }) {
  const { t } = useTranslation();
  if (event.clock_suspect) {
    return (
      <span
        className="pill pill-warning"
        title={t("devices.detail.statusClockHint", {
          defaultValue:
            "The device reported a time we could not believe, so the tap was recorded when it arrived instead. Set the terminal clock via NTP.",
        })}
      >
        {t("devices.detail.statusClock", { defaultValue: "Clock corrected" })}
      </span>
    );
  }
  if (event.status === "skipped") {
    return (
      <span
        className="pill pill-warning"
        title={t("devices.detail.statusHeldHint", {
          defaultValue:
            "Kept, not counted — this device ID is not mapped to an employee yet. Map them in the next tab and this tap is replayed into attendance.",
        })}
      >
        {t("devices.detail.statusHeld", { defaultValue: "Held · unmapped" })}
      </span>
    );
  }
  if (event.status === "failed") {
    return (
      <span
        className="pill pill-danger"
        title={t("devices.detail.statusFailedHint", {
          defaultValue:
            "This tap could not be turned into attendance. Use Sync now to retry it.",
        })}
      >
        {t("devices.detail.statusFailed", { defaultValue: "Failed" })}
      </span>
    );
  }
  if (event.status === "processed") {
    return (
      <span
        className="pill pill-success"
        title={t("devices.detail.statusAttendanceHint", {
          defaultValue: "Counted — this tap is part of the employee's day.",
        })}
      >
        {t("devices.detail.statusAttendance", { defaultValue: "Attendance" })}
      </span>
    );
  }
  return (
    <span
      className="pill pill-neutral"
      title={t("devices.detail.statusPendingHint", {
        defaultValue: "Received, waiting to be processed into attendance.",
      })}
    >
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
      <div className="grid grid-4" style={{ gap: 10, marginBottom: 12 }}>
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
          title={t("devices.detail.tileHeldHint", {
            defaultValue:
              "Taps kept but not counted, because the person who made them is not mapped to an employee yet.",
          })}
          {...(held > 0 ? { tone: "warn" as const } : {})}
        />
      </div>

      {/* The action sits above the table it acts on — an operator who
          sees "3 unmapped" should not have to scroll past the problem to
          find the button that fixes it. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <button
          className="btn btn-sm"
          onClick={doAutoMap}
          disabled={autoMap.isPending || unmapped === 0}
          title={t("devices.detail.autoMapHint", {
            defaultValue:
              "Link every device ID that exactly matches an employee code. Existing mappings are left alone.",
          })}
        >
          <Icon name="zap" size={12} />
          {autoMap.isPending
            ? t("devices.detail.autoMapping", { defaultValue: "Matching…" })
            : t("devices.detail.autoMap", {
                defaultValue: "Auto-map by employee code",
              })}
        </button>
        <div style={{ flex: 1 }} />
        <span
          className={unmapped > 0 ? "pill pill-warning" : "pill pill-success"}
        >
          {unmapped > 0
            ? t("devices.detail.stillUnmapped", {
                count: unmapped,
                defaultValue: `${unmapped} people still unmapped`,
              })
            : t("devices.detail.allMapped", { defaultValue: "Everyone mapped" })}
        </span>
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
      className={`tab${active ? " active" : ""}`}
      onClick={onClick}
      aria-pressed={active}
      style={{ padding: "10px 12px" }}
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

function Meta({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div {...(title ? { title } : {})}>
      <div className="text-xs text-dim">{label}</div>
      <div className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
        {children}
      </div>
    </div>
  );
}

function Tile({
  n,
  label,
  tone,
  title,
}: {
  n: number;
  label: string;
  tone?: "ok" | "warn";
  title?: string;
}) {
  // A zero count is neutral whatever the tone — "0 unmapped" is good
  // news and should not be painted as a warning.
  const color =
    n === 0
      ? "var(--text)"
      : tone === "ok"
        ? "var(--success-text, var(--text))"
        : tone === "warn"
          ? "var(--warning-text, var(--text))"
          : "var(--text)";
  return (
    <div className="stat" {...(title ? { title } : {})}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>
        {n}
      </div>
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
