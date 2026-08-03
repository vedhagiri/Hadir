// Wire types for /api/devices — mirror maugood/devices/schemas.py.
// Credentials (``username`` + ``password``) are outbound-only (POST/PATCH
// bodies). Responses NEVER carry them — only ``host`` / ``port`` /
// ``serial_number`` etc. This is the device analogue of the camera rule
// where ``rtsp_url`` is write-only and responses expose ``rtsp_host``.

// Curated driver menu. The value is what the backend stores; the label is
// what the drawer shows. "generic" is a plain HTTP-webhook fallback.
export const DRIVER_OPTIONS = [
  { value: "hikvision", label: "Hikvision (ISAPI)" },
  { value: "dahua", label: "Dahua" },
  { value: "generic", label: "Generic webhook" },
] as const;

export type DeviceDriver = (typeof DRIVER_OPTIONS)[number]["value"];

// Which employees get their face pushed to this terminal.
export const ENROLLMENT_SCOPE_OPTIONS = [
  { value: "all", label: "All active employees" },
  { value: "department", label: "By department" },
  { value: "zone", label: "By zone" },
] as const;

export type EnrollmentScope = (typeof ENROLLMENT_SCOPE_OPTIONS)[number]["value"];

export interface Device {
  id: number;
  name: string;
  location: string;
  driver: DeviceDriver;
  host: string;
  port: number;
  door_no: string | null;
  // Auto-read from the device on save (``/deviceInfo``). Unique per tenant.
  // Immutable in this UI — shown as a read-only mono badge on edit.
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
}

export interface DeviceListResponse {
  items: Device[];
}

export interface DeviceCreateInput {
  name: string;
  location: string;
  driver: DeviceDriver;
  host: string;
  port: number;
  username: string;
  password: string;
  door_no?: string | null;
  enrollment_scope: EnrollmentScope;
  enabled: boolean;
}

export interface DevicePatchInput {
  name?: string;
  location?: string;
  driver?: DeviceDriver;
  host?: string;
  port?: number;
  // Send BOTH only when rotating credentials. Omit to leave the stored
  // (Fernet-encrypted) cipher untouched — same contract as camera rtsp_url.
  username?: string;
  password?: string;
  door_no?: string | null;
  enrollment_scope?: EnrollmentScope;
  enabled?: boolean;
}
