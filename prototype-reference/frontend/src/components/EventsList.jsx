import { useState } from 'react'
import { faceImageUrl } from '../api'
import { usePolling } from '../hooks/usePolling'
import { api } from '../api'

/**
 * Grid of recent events. Polls /api/events every 3 seconds.
 * Date filter defaults to today. Camera filter follows the currently
 * selected camera (or "all").
 */
export default function EventsList({ selectedCameraId, onOpenEvent }) {
  const today = new Date().toISOString().slice(0, 10)
  const [date, setDate] = useState(today)
  const [filterCamera, setFilterCamera] = useState(true)  // true = use selectedCameraId

  const fetcher = () =>
    api.listEvents({
      date: date || undefined,
      cameraId: filterCamera && selectedCameraId ? selectedCameraId : undefined,
      limit: 60,
    })

  const { data, error } = usePolling(fetcher, 3000, true)
  const events = data?.events || []

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 style={{ margin: 0 }}>Events</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{ margin: 0, fontSize: 12 }}>
            Date:&nbsp;
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ width: 'auto', display: 'inline-block', padding: '4px 8px' }}
            />
          </label>
          <button
            className={'btn-ghost btn-sm' + (filterCamera ? ' active' : '')}
            onClick={() => setFilterCamera(!filterCamera)}
            disabled={!selectedCameraId}
            title={selectedCameraId
              ? 'Toggle between showing only the selected camera, or all cameras'
              : 'Select a camera to enable this filter'}
          >
            {filterCamera && selectedCameraId ? 'This camera' : 'All cameras'}
          </button>
        </div>
      </div>

      {error && <div className="error-msg">Failed to load: {error.message}</div>}

      {events.length === 0 ? (
        <div className="empty-big">
          <div className="empty-big-icon">▣</div>
          <div className="empty-big-title">
            No events {filterCamera && selectedCameraId ? 'on this camera' : ''} for {date}
          </div>
          <div className="empty-big-hint">
            Start a stream and walk past the camera — events will appear here as people are detected.
          </div>
        </div>
      ) : (
        <div className="events-grid">
          {events.map((ev) => (
            <EventCard key={ev.id} event={ev} onClick={() => onOpenEvent(ev.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function EventCard({ event, onClick }) {
  const timeOnly = event.started_at?.slice(11, 19) || '?'
  const duration =
    event.duration_sec != null
      ? `${Math.round(event.duration_sec)}s`
      : '…live'

  return (
    <div
      className={'event-card' + (event.max_duration_hit ? ' max-hit' : '')}
      onClick={onClick}
      title={event.max_duration_hit ? 'Max duration hit (person stayed >60s)' : ''}
    >
      <div className="event-thumb">
        {event.best_face_id ? (
          <img src={faceImageUrl(event.best_face_id)} alt="best face" loading="lazy" />
        ) : (
          <span className="no-thumb">no face</span>
        )}
      </div>
      <div className="event-meta">
        <div className="time">{timeOnly} · {duration}</div>
        <div className="camera">{event.camera_name}</div>
        {event.person_name && (
          <div className="name">✓ {event.person_name}</div>
        )}
        <div className="count">
          {event.faces_saved} face{event.faces_saved === 1 ? '' : 's'}
          {' · '}{event.frames_seen} frames
        </div>
      </div>
    </div>
  )
}