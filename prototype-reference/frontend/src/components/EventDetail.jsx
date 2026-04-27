import { useEffect, useState } from 'react'
import { api, faceImageUrl } from '../api'

/**
 * Modal showing the full detail of an event — all saved faces in order
 * of quality, plus metadata. Click a face to open it full-size in a new tab.
 */
export default function EventDetail({ eventId, onClose }) {
  const [event, setEvent] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!eventId) return
    setEvent(null); setError(null)
    api.getEvent(eventId)
      .then(setEvent)
      .catch((err) => setError(err.message))
  }, [eventId])

  if (!eventId) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 720 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Event detail</h3>

        {error && <div className="error-msg">Failed to load: {error}</div>}
        {!event && !error && <div className="empty">Loading…</div>}

        {event && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 13 }}>
              <div><span style={{ color: 'var(--muted)' }}>Camera: </span>{event.camera_name}</div>
              <div><span style={{ color: 'var(--muted)' }}>Date: </span>{event.date}</div>
              <div><span style={{ color: 'var(--muted)' }}>Started: </span>{event.started_at?.slice(11, 19)}</div>
              <div>
                <span style={{ color: 'var(--muted)' }}>Ended: </span>
                {event.ended_at?.slice(11, 19) || '(still live)'}
              </div>
              <div>
                <span style={{ color: 'var(--muted)' }}>Duration: </span>
                {event.duration_sec != null
                  ? `${event.duration_sec.toFixed(1)}s`
                  : '…'}
                {event.max_duration_hit && (
                  <span className="pill warn" style={{ marginLeft: 6, fontSize: 10, padding: '2px 6px' }}>
                    max hit
                  </span>
                )}
              </div>
              <div>
                <span style={{ color: 'var(--muted)' }}>Frames: </span>
                {event.frames_seen} · {event.faces_saved} saved
              </div>
              {event.person_name && (
                <div style={{ gridColumn: 'span 2' }}>
                  <span style={{ color: 'var(--muted)' }}>Identified: </span>
                  <strong>{event.person_name}</strong>
                  {event.match_score != null && (
                    <span style={{ color: 'var(--muted)' }}>
                      {' '}· {(event.match_score * 100).toFixed(0)}% match
                    </span>
                  )}
                </div>
              )}
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
                Saved faces ({event.faces.length}) — click to view full-size
              </div>
              {event.faces.length === 0 ? (
                <div className="empty">No faces saved for this event.</div>
              ) : (
                <div className="face-grid">
                  {event.faces.map((f) => (
                    <img
                      key={f.id}
                      src={faceImageUrl(f.id)}
                      title={`q=${f.quality.toFixed(2)} · ${f.face_width}×${f.face_height} · det=${(f.det_score || 0).toFixed(2)}`}
                      onClick={() => window.open(faceImageUrl(f.id), '_blank')}
                      alt={`face ${f.id}`}
                    />
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: 10, fontSize: 11, color: 'var(--dim)' }}>
              Folder: <code>{event.folder}</code>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}