import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { usePolling } from '../hooks/usePolling'

/**
 * Dashboard — quick snapshot of the system.
 * Shows: capture status, today's events, identified/unknown split, camera count,
 * enrolled-people count, latest report link.
 */
export default function DashboardPage({ onNavigate }) {
  const [cameras, setCameras] = useState([])
  const [people, setPeople] = useState([])
  const [reports, setReports] = useState([])
  const [loadErr, setLoadErr] = useState(null)

  const loadCoreData = useCallback(async () => {
    try {
      const [c, p, r] = await Promise.all([
        api.listCameras(),
        api.listKnownPeople(),
        api.listReports(),
      ])
      setCameras(c || [])
      setPeople(p?.people || [])
      setReports(r?.reports || [])
      setLoadErr(null)
    } catch (err) {
      setLoadErr(err.message)
    }
  }, [])

  useEffect(() => { loadCoreData() }, [loadCoreData])

  // Live capture status — polled while the page is open
  const { data: streamState } = usePolling(api.streamStatus, 2000, true)

  // Today's events — polled too
  const today = new Date().toISOString().slice(0, 10)
  const { data: eventsData } = usePolling(
    () => api.listEvents({ date: today, limit: 200 }),
    5000,
    true,
  )

  const events = eventsData?.events || []
  const identified = events.filter((e) => e.person_name).length
  const unknown = events.length - identified

  const isCapturing = streamState?.running
  const currentCam = streamState?.camera_name

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <div className="page-subtitle">
            {new Date().toLocaleDateString(undefined, {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            })}
          </div>
        </div>
        <div className="page-actions">
          {isCapturing ? (
            <span className="pill ok">● Capturing · {currentCam}</span>
          ) : (
            <span className="pill">Capture idle</span>
          )}
        </div>
      </div>

      {loadErr && <div className="error-msg">Could not load dashboard: {loadErr}</div>}

      <div className="stats-grid">
        <StatCard
          label="Today's events"
          value={events.length}
          hint={`${identified} identified · ${unknown} unknown`}
          onClick={() => onNavigate('cameras')}
        />
        <StatCard
          label="Cameras"
          value={cameras.length}
          hint={`${cameras.filter((c) => c.enabled).length} enabled`}
          onClick={() => onNavigate('cameras')}
        />
        <StatCard
          label="Known people"
          value={people.length}
          hint={`${people.reduce((s, p) => s + p.n_photos, 0)} reference photos`}
          onClick={() => onNavigate('people')}
        />
        <StatCard
          label="Reports"
          value={reports.length}
          hint="Click to generate new"
          onClick={() => onNavigate('reports')}
        />
      </div>

      <div className="layout-2col">
        <div className="panel">
          <div className="panel-header">
            <h2 className="panel-title-lg">Recent identified events</h2>
            <button className="btn-ghost btn-sm" onClick={() => onNavigate('cameras')}>
              View all
            </button>
          </div>
          {events.length === 0 ? (
            <div className="empty-big">
              <div className="empty-big-icon">▣</div>
              <div className="empty-big-title">No events today yet</div>
              <div className="empty-big-hint">
                Go to Cameras and click a camera to start capturing.
              </div>
            </div>
          ) : (
            <RecentEventsList events={events.slice(0, 6)} />
          )}
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2 className="panel-title-lg">Latest reports</h2>
            <button className="btn-ghost btn-sm" onClick={() => onNavigate('reports')}>
              Generate
            </button>
          </div>
          {reports.length === 0 ? (
            <div className="empty-big">
              <div className="empty-big-icon">▤</div>
              <div className="empty-big-title">No reports yet</div>
              <div className="empty-big-hint">
                Generate your first Excel report for any date.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {reports.slice(0, 5).map((r) => (
                <div key={r.name} className="report-row">
                  <span className={`report-kind-badge ${r.kind}`}>{r.kind}</span>
                  <span className="report-name">{r.name}</span>
                  <span className="report-meta">{ageString(r.mtime)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, hint, onClick }) {
  return (
    <div
      className="stat-card"
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}

function RecentEventsList({ events }) {
  // Mini timeline view instead of full cards
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {events.map((ev) => (
        <div key={ev.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px',
          background: '#0f0f15',
          border: '1px solid var(--panel-border)',
          borderRadius: 8,
        }}>
          <div style={{
            width: 42, height: 42, borderRadius: 6,
            background: '#000', overflow: 'hidden', flexShrink: 0,
          }}>
            {ev.best_face_id ? (
              <img
                src={`${import.meta.env.VITE_API_BASE || 'http://localhost:5006'}/api/face/${ev.best_face_id}`}
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                alt=""
              />
            ) : null}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {ev.person_name || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>unknown</span>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {ev.started_at?.slice(11, 19)} · {ev.camera_name}
            </div>
          </div>
          {ev.match_score != null && ev.person_name && (
            <span className="pill ok" style={{ fontSize: 10, padding: '2px 7px' }}>
              {Math.round(ev.match_score * 100)}%
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

function ageString(mtimeSec) {
  const secs = Date.now() / 1000 - mtimeSec
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}