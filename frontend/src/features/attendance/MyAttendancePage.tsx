// Employee self-view (P12). Mounted at both /attendance/me (the
// pilot-plan path) and /my-attendance (the NAV id used in the
// HR / Manager / Employee menus from design/shell.jsx).
//
// Same data for self only — no department / employee filters. The
// backend's /api/attendance auto-scopes the Employee role; the
// /me/recent endpoint is self-only by design.

import { useMemo, useState } from "react";

import { useMe } from "../../auth/AuthProvider";
import { AttendanceDrawer } from "./AttendanceDrawer";
import { FlagPills } from "./DailyAttendancePage";
import { useAttendance, useMyRecentAttendance } from "./hooks";
import type { AttendanceItem } from "./types";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function MyAttendancePage() {
  const me = useMe();
  const today = useAttendance(todayIso(), null);
  const recent = useMyRecentAttendance(7);
  const [drawerItem, setDrawerItem] = useState<AttendanceItem | null>(null);

  const todayItem = today.data?.items[0] ?? null;
  const recentSorted = useMemo(() => {
    const items = recent.data?.items ?? [];
    // /me/recent is already date-desc, but be defensive.
    return [...items].sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [recent.data]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {me.data ? `Hello, ${firstName(me.data.full_name)}` : "My attendance"}
          </h1>
          <p className="page-sub">
            Your attendance today and the last 7 days.
          </p>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Today</h3>
            <span className="text-xs text-dim mono">{todayIso()}</span>
          </div>
          <div className="card-body">
            {today.isLoading && <div className="text-sm text-dim">Loading…</div>}
            {!today.isLoading && !todayItem && (
              <div className="text-sm text-dim">
                No attendance row yet. The recompute job runs every 15
                minutes; come back after walking past a camera.
              </div>
            )}
            {todayItem && (
              <div
                onClick={() => setDrawerItem(todayItem)}
                style={{ cursor: "pointer" }}
              >
                <div className="grid grid-4" style={{ gap: 10, marginBottom: 12 }}>
                  <Tile label="In" value={todayItem.in_time ?? "—"} />
                  <Tile label="Out" value={todayItem.out_time ?? "—"} />
                  <Tile
                    label="Total"
                    value={
                      todayItem.total_minutes !== null
                        ? `${(todayItem.total_minutes / 60).toFixed(2)}h`
                        : "—"
                    }
                  />
                  <Tile
                    label="OT"
                    value={
                      todayItem.overtime_minutes > 0
                        ? `${(todayItem.overtime_minutes / 60).toFixed(2)}h`
                        : "0h"
                    }
                  />
                </div>
                <FlagPills item={todayItem} />
                <div
                  className="text-xs text-dim"
                  style={{ marginTop: 6 }}
                >
                  Click for the underlying detection events.
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Last 7 days</h3>
            <span className="text-xs text-dim">
              {recent.data ? `${recent.data.items.length} record(s)` : "—"}
            </span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>In</th>
                <th>Out</th>
                <th>Total</th>
                <th>Flags</th>
              </tr>
            </thead>
            <tbody>
              {recent.isLoading && (
                <tr>
                  <td colSpan={5} className="text-sm text-dim" style={{ padding: 12 }}>
                    Loading…
                  </td>
                </tr>
              )}
              {recentSorted.map((it) => (
                <tr
                  key={it.date}
                  onClick={() => setDrawerItem(it)}
                  style={{ cursor: "pointer" }}
                >
                  <td className="mono text-sm">{it.date}</td>
                  <td className="mono text-sm">{it.in_time ?? "—"}</td>
                  <td className="mono text-sm">{it.out_time ?? "—"}</td>
                  <td className="mono text-sm">
                    {it.total_minutes !== null
                      ? `${(it.total_minutes / 60).toFixed(1)}h`
                      : "—"}
                  </td>
                  <td>
                    <FlagPills item={it} />
                  </td>
                </tr>
              ))}
              {recent.data && recent.data.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-sm text-dim" style={{ padding: 12 }}>
                    No history yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {drawerItem && (
        <AttendanceDrawer item={drawerItem} onClose={() => setDrawerItem(null)} />
      )}
    </>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "10px 12px",
        background: "var(--bg-sunken)",
        borderRadius: 8,
      }}
    >
      <div
        className="text-xs text-dim"
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 500, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

function firstName(full: string): string {
  return full.split(/\s+/)[0] ?? full;
}
