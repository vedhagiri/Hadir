// Wire types for /api/system/*.

export interface SystemHealth {
  backend_uptime_seconds: number;
  process_pid: number;
  db_connections_active: number;
  capture_workers_running: number;
  attendance_scheduler_running: boolean;
  rate_limiter_running: boolean;
  enrolled_employees: number;
  employees_active: number;
  cameras_total: number;
  cameras_enabled: number;
  detection_events_today: number;
  attendance_records_today: number;
}

export interface CameraHealthPoint {
  captured_at: string;
  frames_last_minute: number;
  reachable: boolean;
}

export interface CameraHealth {
  camera_id: number;
  name: string;
  location: string;
  enabled: boolean;
  rtsp_host: string;
  last_seen_at: string | null;
  latest_frames_last_minute: number;
  latest_reachable: boolean;
  series_24h: CameraHealthPoint[];
}

export interface CamerasHealthResponse {
  items: CameraHealth[];
}
