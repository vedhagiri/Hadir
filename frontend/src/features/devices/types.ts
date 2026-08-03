// Wire types for /api/devices — mirror maugood/devices/schemas.py.
//
// Devices are registered in *push* mode: the terminal posts its events to a
// URL we generate, so we never ask for an IP, port or device password. The
// generated ``push_url`` contains the token and is only ever returned to an
// authenticated Admin — treat it like a credential in the UI (no logging,
// no analytics, copy-to-clipboard only).
//
// The legacy *pull* fields (host/port/username/password) remain on the
// types for devices registered before the switch; they are never collected
// by the current UI.

// Curated driver menu. The value is what the backend stores; the label is
// what the drawer shows. "generic" is a plain HTTP-webhook fallback.
export const DRIVER_OPTIONS = [
  { value: "hikvision", label: "Hikvision (ISAPI)" },
  { value: "dahua", label: "Dahua" },
  { value: "generic", label: "Generic webhook" },
] as const;

export type DeviceDriver = (typeof DRIVER_OPTIONS)[number]["value"];

// Which employees get their face pushed to this terminal. Only meaningful
// for pull devices — a push device cannot be reached to receive photos.
export const ENROLLMENT_SCOPE_OPTIONS = [
  { value: "all", label: "All active employees" },
  { value: "department", label: "By department" },
  { value: "zone", label: "By zone" },
] as const;

export type EnrollmentScope = (typeof ENROLLMENT_SCOPE_OPTIONS)[number]["value"];

export type ConnectionMode = "push" | "pull" | "both";

export interface Device {
  id: number;
  name: string;
  location: string;
  driver: DeviceDriver;
  host: string | null;
  port: number | null;
  door_no: string | null;
  // Learned from the first event a push device sends; read from the device
  // on save for a pull device. Read-only in this UI either way.
  serial_number: string | null;
  model: string | null;
  firmware: string | null;
  enabled: boolean;
  enrollment_scope: EnrollmentScope;
  health_status: "online" | "unreachable" | "unknown";
  users_synced: number;
  last_user_sync_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  connection_mode: ConnectionMode;
  // The complete URL an operator pastes into the terminal. Carries the
  // token — never render it outside the setup panel.
  push_url: string | null;
  push_token: string | null;
  last_event_at: string | null;
  // Set when the terminal reported a timestamp we refused to believe
  // (typically an unset clock stamping 1970).
  clock_suspect: boolean;
  reported_device_name: string | null;
  users_total: number;
  users_unmapped: number;
}

export interface DeviceListResponse {
  items: Device[];
}

// Push registration: a name, an optional label, and nothing else.
export interface DeviceCreateInput {
  name: string;
  location: string;
  driver: DeviceDriver;
  enabled: boolean;
}

export interface DevicePatchInput {
  name?: string;
  location?: string;
  driver?: DeviceDriver;
  enabled?: boolean;
}

// --- people the device has reported ----------------------------------------

export interface DeviceUser {
  id: number;
  device_user_id: string;
  name: string | null;
  card_no: string | null;
  employee_id: number | null;
  mapping_status: string;
  face_synced: boolean;
  synced_at: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  taps_count: number;
  source: "sync" | "events";
  employee_code: string | null;
  employee_name: string | null;
}

export interface DeviceUserListResponse {
  items: DeviceUser[];
}

export interface MapDeviceUserResult {
  device_user_id: string;
  employee_id: number | null;
  // Taps that arrived before the mapping existed and have now been replayed
  // into attendance.
  replayed: number;
}

export interface AutoMapResult {
  mapped: number;
  still_unmapped: number;
  replayed: number;
}

// --- raw taps ---------------------------------------------------------------

export interface DeviceEvent {
  id: number;
  device_user_id: string;
  person_name: string | null;
  event_serial: string;
  occurred_at: string;
  received_at: string;
  verify_mode: string | null;
  direction: string | null;
  status: "pending" | "processed" | "failed" | "skipped";
  clock_suspect: boolean;
  employee_id: number | null;
}

export interface DeviceEventListResponse {
  items: DeviceEvent[];
}
