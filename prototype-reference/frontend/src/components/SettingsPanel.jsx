import { useEffect, useState } from 'react'
import { api } from '../api'

const DET_SIZES = [
  { value: 160, label: '160', hint: 'fastest, misses small faces' },
  { value: 224, label: '224', hint: 'fast' },
  { value: 320, label: '320', hint: 'balanced (recommended)' },
  { value: 480, label: '480', hint: 'slower, catches smaller faces' },
  { value: 640, label: '640', hint: 'slowest, best for distant faces' },
]

/**
 * Settings panel on the Cameras page.
 *   - Detector mode (InsightFace / YOLO+Face)
 *   - Body box overlay in preview
 *   - Detector input size (speed/accuracy tradeoff)
 *
 * All changes take effect on the next processed frame — no restart needed.
 */
export default function SettingsPanel() {
  const [settings, setSettings] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    api.getSettings()
      .then(setSettings)
      .catch((err) => setError(err.message))
  }, [])

  const patch = async (update) => {
    setSaving(true); setError(null)
    try {
      const s = await api.updateSettings(update)
      setSettings(s)
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  if (!settings) {
    return (
      <div className="panel">
        <h2 className="panel-title">Settings</h2>
        <div className="hint">Loading…</div>
        {error && <div className="error-msg">{error}</div>}
      </div>
    )
  }

  return (
    <div className="panel">
      <h2 className="panel-title" style={{ marginBottom: 12 }}>Settings</h2>

      <div style={{ marginBottom: 14 }}>
        <label>Detector</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            className={'btn-ghost btn-sm' + (settings.detector_mode === 'insightface' ? ' active' : '')}
            onClick={() => patch({ detector_mode: 'insightface' })}
            disabled={saving}
          >
            InsightFace
          </button>
          <button
            className={'btn-ghost btn-sm' + (settings.detector_mode === 'yolo+face' ? ' active' : '')}
            onClick={() => patch({ detector_mode: 'yolo+face' })}
            disabled={saving}
          >
            YOLO + Face
          </button>
        </div>
        <div className="hint">
          {settings.detector_mode === 'insightface'
            ? 'Full-frame face detection. Simpler and usually faster.'
            : 'YOLO finds people first, then face detection inside each body box.'}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label>Detector input size</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {DET_SIZES.map((d) => (
            <button
              key={d.value}
              className={'btn-ghost btn-sm' + (settings.det_size === d.value ? ' active' : '')}
              onClick={() => patch({ det_size: d.value })}
              disabled={saving}
              title={d.hint}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="hint">
          {DET_SIZES.find((d) => d.value === settings.det_size)?.hint ||
            'Controls speed vs. ability to detect small faces.'}
        </div>
      </div>

      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: 'var(--text)' }}>
          <input
            type="checkbox"
            checked={settings.show_body_boxes}
            onChange={(e) => patch({ show_body_boxes: e.target.checked })}
            disabled={saving}
            style={{ width: 'auto' }}
          />
          <span style={{ fontSize: 13 }}>Show body boxes in preview</span>
        </label>
        <div className="hint">
          Draws a full-body rectangle around each detected person in the live preview.
          Preview-only — body crops are not saved to disk.
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}
    </div>
  )
}