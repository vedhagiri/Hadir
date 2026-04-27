import { apiUrl } from './config'

async function jsonFetch(path, opts = {}) {
  const resp = await fetch(apiUrl(path), {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  if (resp.status === 204) return null
  const text = await resp.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!resp.ok) {
    const msg = (body && (body.detail || body.error)) || resp.statusText
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return body
}

// Separate helper for uploads — don't set Content-Type, browser fills in boundary
async function uploadFile(path, file) {
  const form = new FormData()
  form.append('file', file)
  const resp = await fetch(apiUrl(path), { method: 'POST', body: form })
  const text = await resp.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!resp.ok) {
    throw new Error((body && (body.detail || body.error)) || resp.statusText)
  }
  return body
}

export const api = {
  // Cameras CRUD
  listCameras: () => jsonFetch('/api/cameras'),
  createCamera: (data) =>
    jsonFetch('/api/cameras', { method: 'POST', body: JSON.stringify(data) }),
  updateCamera: (id, data) =>
    jsonFetch(`/api/cameras/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteCamera: (id) =>
    jsonFetch(`/api/cameras/${id}`, { method: 'DELETE' }),

  // Stream control
  startStream: (camera_id) =>
    jsonFetch('/api/stream/start', {
      method: 'POST', body: JSON.stringify({ camera_id }),
    }),
  stopStream: () => jsonFetch('/api/stream/stop', { method: 'POST' }),
  streamStatus: () => jsonFetch('/api/stream/status'),

  // Events
  listEvents: ({ date, cameraId, limit = 50, offset = 0 } = {}) => {
    const params = new URLSearchParams()
    if (date) params.set('date', date)
    if (cameraId) params.set('camera_id', cameraId)
    params.set('limit', limit)
    params.set('offset', offset)
    return jsonFetch(`/api/events?${params}`)
  },
  getEvent: (id) => jsonFetch(`/api/events/${id}`),

  // Settings
  getSettings: () => jsonFetch('/api/settings'),
  updateSettings: (data) =>
    jsonFetch('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),

  // Known people (Round 2)
  listKnownPeople: () => jsonFetch('/api/known_people'),
  createKnownPerson: (name) =>
    jsonFetch('/api/known_people', {
      method: 'POST', body: JSON.stringify({ name }),
    }),
  uploadKnownPhoto: (name, file) =>
    uploadFile(`/api/known_people/${encodeURIComponent(name)}/photo`, file),
  deleteKnownPerson: (name) =>
    jsonFetch(`/api/known_people/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  deleteKnownPhoto: (name, filename) =>
    jsonFetch(
      `/api/known_people/${encodeURIComponent(name)}/photo/${encodeURIComponent(filename)}`,
      { method: 'DELETE' },
    ),
  reloadKnownPeople: () =>
    jsonFetch('/api/known_people/reload', { method: 'POST' }),

  // Jobs (Round 2)
  listJobs: () => jsonFetch('/api/jobs'),
  getJob: (id) => jsonFetch(`/api/jobs/${id}`),

  // Identify (Round 2)
  runIdentify: (body) =>
    jsonFetch('/api/identify/run', {
      method: 'POST', body: JSON.stringify(body || {}),
    }),

  // Reports (Round 2)
  generateReport: (body) =>
    jsonFetch('/api/report/generate', {
      method: 'POST', body: JSON.stringify(body),
    }),
  // Attendance report (Round 3)
  generateAttendance: (body) =>
    jsonFetch('/api/report/attendance/generate', {
      method: 'POST', body: JSON.stringify(body),
    }),
  listReports: () => jsonFetch('/api/reports'),
}

// Absolute URLs for <img> tags and downloads
export const previewStreamUrl = (cacheBust = true) =>
  cacheBust ? apiUrl(`/api/stream/preview?t=${Date.now()}`)
            : apiUrl('/api/stream/preview')

export const faceImageUrl = (faceId) => apiUrl(`/api/face/${faceId}`)

export const knownPhotoUrl = (name, filename) =>
  apiUrl(`/api/known_people/${encodeURIComponent(name)}/photo/${encodeURIComponent(filename)}`)

export const reportDownloadUrl = (filename) =>
  apiUrl(`/api/report/download/${encodeURIComponent(filename)}`)