// Pure helpers for the Clip Logs page — formatting, day grouping and
// date-preset maths. No React, no I/O.

import { todayIso } from "../../components/DatePicker";
import type { PersonClipOut } from "../person-clips/types";

export type Mode = "save_clips" | "logs_only";
export type DatePreset = "all" | "today" | "yesterday" | "last7" | "custom";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local YYYY-MM-DD of a Date (matches the pickers + ``dayBound``). */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function shiftDay(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return localDayKey(new Date(y, m - 1, d + delta));
}

export function presetRange(p: Exclude<DatePreset, "custom" | "all">): { start: string; end: string | null } {
  const today = todayIso();
  if (p === "today") return { start: today, end: null };
  if (p === "yesterday") return { start: shiftDay(today, -1), end: null };
  return { start: shiftDay(today, -6), end: today };
}

/** Which preset (if any) the current start/end pair corresponds to. */
export function detectPreset(start: string | null, end: string | null): DatePreset {
  if (!start && !end) return "all";
  const today = todayIso();
  if (start === today && !end) return "today";
  if (start === shiftDay(today, -1) && !end) return "yesterday";
  if (start === shiftDay(today, -6) && end === today) return "last7";
  return "custom";
}

/** "42s" · "3m 05s" · "1h 12m". ``—`` for non-positive. */
export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${pad(m)}m`;
}

export function fmtFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface DayGroup {
  key: string;
  date: Date;
  clips: PersonClipOut[];
  totalSeconds: number;
}

/** Group page rows by local calendar day, preserving API order. */
export function groupByDay(items: PersonClipOut[]): DayGroup[] {
  const out: DayGroup[] = [];
  const idx = new Map<string, DayGroup>();
  for (const c of items) {
    const d = new Date(c.clip_start);
    const key = localDayKey(d);
    let g = idx.get(key);
    if (!g) {
      g = { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), clips: [], totalSeconds: 0 };
      idx.set(key, g);
      out.push(g);
    }
    g.clips.push(c);
    g.totalSeconds += Math.max(0, c.duration_seconds || 0);
  }
  return out;
}

/** Seconds since local midnight. */
export function secondsOfDay(d: Date): number {
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

export function hasVideo(c: PersonClipOut): boolean {
  return c.recording_mode !== "logs_only";
}

export function isPlayable(c: PersonClipOut): boolean {
  return hasVideo(c) && c.recording_status === "completed";
}
