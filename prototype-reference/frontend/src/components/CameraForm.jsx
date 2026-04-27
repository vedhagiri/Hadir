import { useEffect, useState } from 'react'

/**
 * Modal form for add/edit. If `initial` is provided, it's edit mode.
 *
 * On submit, calls onSubmit({name, url, enabled}) — parent handles the
 * API call and closes the modal by setting initial/open state.
 */
export default function CameraForm({ initial, onSubmit, onCancel }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (initial) {
      setName(initial.name || '')
      setUrl(initial.url || '')
      setEnabled(initial.enabled !== false)
    } else {
      setName(''); setUrl(''); setEnabled(true)
    }
    setError(null)
  }, [initial])

  const handleSubmit = async () => {
    if (!name.trim()) { setError('Name is required'); return }
    if (!url.trim()) { setError('RTSP URL is required'); return }
    setSubmitting(true); setError(null)
    try {
      await onSubmit({ name: name.trim(), url: url.trim(), enabled })
    } catch (err) {
      setError(err.message || String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? 'Edit camera' : 'Add camera'}</h3>

        <div className="row">
          <div className="col-wide">
            <label>Camera name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Front Door"
              autoFocus
            />
          </div>
        </div>

        <div className="row">
          <div className="col-wide">
            <label>RTSP URL (include user:pass if required)</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="rtsp://admin:pass@192.168.0.210:554/video/live?channel=1&subtype=0"
            />
            <div className="hint">
              CP Plus: rtsp://IP:554/cam/realmonitor?channel=1&amp;subtype=1 (sub stream recommended)
            </div>
          </div>
        </div>

        <div className="row">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text)' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Enabled (disable to keep the camera registered but skip streaming)
          </label>
        </div>

        {error && <div className="error-msg">{error}</div>}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Saving…' : (initial ? 'Save changes' : 'Add camera')}
          </button>
        </div>
      </div>
    </div>
  )
}