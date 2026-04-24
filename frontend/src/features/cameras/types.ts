// Wire types for /api/cameras — mirror hadir/cameras/schemas.py.
// ``rtsp_url`` is outbound-only (POST/PATCH bodies). Responses carry
// ``rtsp_host`` only.

export interface Camera {
  id: number;
  name: string;
  location: string;
  rtsp_host: string;
  enabled: boolean;
  created_at: string;
  last_seen_at: string | null;
  images_captured_24h: number;
}

export interface CameraListResponse {
  items: Camera[];
}

export interface CameraCreateInput {
  name: string;
  location: string;
  rtsp_url: string;
  enabled: boolean;
}

export interface CameraPatchInput {
  name?: string;
  location?: string;
  rtsp_url?: string;
  enabled?: boolean;
}
