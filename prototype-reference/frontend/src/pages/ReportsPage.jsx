import { useCallback, useEffect, useState } from 'react'
import { api, reportDownloadUrl } from '../api'

/**
 * Reports page:
 *   - Type selector:  Event log   |   Attendance
 *   - Date picker + options per type
 *   - Generate button → polls job → download appears when ready
 *   - Unified list of all previous reports with type badges
 */
export default function ReportsPage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [reportType, setReportType] = useState('event')  // 'event' | 'attendance'
  const [autoIdentify, setAutoIdentify] = useState(true)
  const [includeUnknown, setIncludeUnknown] = useState(true)
  const [jobId, setJobId] = useState(null)
  const [job, setJob] = useState(null)
  const [reports, setReports] = useState([])
  const [folder, setFolder] = useState('')
  const [error, setError] = useState(null)
  const [typeFilter, setTypeFilter] = useState('all')    // 'all' | 'event' | 'attendance'

  const loadReports = useCallback(async () => {
    try {
      const data = await api.listReports()
      setReports(data.reports || [])
      setFolder(data.folder || '')
    } catch (err) { setError(err.message) }
  }, [])
  useEffect(() => { loadReports() }, [loadReports])

  // Poll the active job
  useEffect(() => {
    if (!jobId) return
    let cancelled = false
    const tick = async () => {
      try {
        const j = await api.getJob(jobId)
        if (cancelled) return
        setJob(j)
        if (j.status === 'done' || j.status === 'error') {
          setJobId(null)
          loadReports()
        }
      } catch (err) { if (!cancelled) setError(err.message) }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => { cancelled = true; clearInterval(id) }
  }, [jobId, loadReports])

  const handleGenerate = async () => {
    setError(null); setJob(null)
    try {
      let r
      if (reportType === 'event') {
        r = await api.generateReport({
          date, auto_identify: autoIdentify, include_unknown: includeUnknown,
        })
      } else {
        r = await api.generateAttendance({ date, auto_identify: autoIdentify })
      }
      if (!r.ok) throw new Error(r.error || 'failed')
      setJobId(r.job_id)
    } catch (err) { setError(err.message) }
  }

  const handleIdentifyOnly = async () => {
    setError(null); setJob(null)
    try {
      const r = await api.runIdentify({ date, reidentify: false })
      if (!r.ok) throw new Error(r.error || 'failed')
      setJobId(r.job_id)
    } catch (err) { setError(err.message) }
  }

  const running = jobId != null && job?.status === 'running'

  const filtered = reports.filter(
    (r) => typeFilter === 'all' || r.kind === typeFilter,
  )

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <div className="page-subtitle">
            Generate daily event logs and attendance reports
          </div>
        </div>
      </div>

      <div className="panel">
        <h2 className="panel-title-lg" style={{ marginBottom: 14 }}>Generate a report</h2>

        {/* Report type selector */}
        <div style={{ marginBottom: 14 }}>
          <label>Report type</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className={'btn-ghost btn-sm' + (reportType === 'event' ? ' active' : '')}
              onClick={() => setReportType('event')}
              disabled={running}
            >
              Event log
            </button>
            <button
              className={'btn-ghost btn-sm' + (reportType === 'attendance' ? ' active' : '')}
              onClick={() => setReportType('attendance')}
              disabled={running}
            >
              Attendance
            </button>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {reportType === 'event'
              ? 'One row per detected appearance: camera, time, person, reference photo, thumbnail.'
              : 'One row per identified person per day: camera in, times in/out, total duration, reference photo, in-snapshot.'}
          </div>
        </div>

        {/* Options */}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: '0 0 auto' }}>
            <label>Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              style={{ width: 160 }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text)' }}>
              <input
                type="checkbox"
                checked={autoIdentify}
                onChange={(e) => setAutoIdentify(e.target.checked)}
                style={{ width: 'auto' }}
              />
              Identify events first
            </label>
            {reportType === 'event' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  checked={includeUnknown}
                  onChange={(e) => setIncludeUnknown(e.target.checked)}
                  style={{ width: 'auto' }}
                />
                Include unidentified events
              </label>
            )}
          </div>

          <button className="btn-primary" onClick={handleGenerate} disabled={running}>
            {running ? 'Working…' : 'Generate report'}
          </button>
          <button className="btn-ghost" onClick={handleIdentifyOnly} disabled={running}
                  title="Match events against known people without generating Excel">
            Identify only
          </button>
        </div>

        {error && <div className="error-msg">{error}</div>}

        {job && <JobStatus job={job} />}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2 className="panel-title-lg">Previous reports</h2>
          <div style={{ display: 'flex', gap: 4 }}>
            {['all', 'event', 'attendance'].map((t) => (
              <button
                key={t}
                className={'btn-ghost btn-sm' + (typeFilter === t ? ' active' : '')}
                onClick={() => setTypeFilter(t)}
              >
                {t === 'all' ? 'All' : t === 'event' ? 'Event log' : 'Attendance'}
              </button>
            ))}
            <button className="btn-ghost btn-sm" onClick={loadReports}>Refresh</button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="empty-big">
            <div className="empty-big-icon">▤</div>
            <div className="empty-big-title">No reports yet</div>
            <div className="empty-big-hint">
              {reports.length === 0
                ? 'Generate your first report using the panel above.'
                : 'No reports of this type. Try a different filter.'}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filtered.map((r) => (
              <div key={r.name} className="report-row">
                <span className={`report-kind-badge ${r.kind}`}>
                  {r.kind === 'attendance' ? 'attendance' : 'events'}
                </span>
                <span className="report-name">{r.name}</span>
                <span className="report-meta">
                  {r.size_kb} KB · {ageString(r.mtime)}
                </span>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => window.open(reportDownloadUrl(r.name), '_blank')}
                >
                  Open
                </button>
              </div>
            ))}
          </div>
        )}
        {folder && <div className="hint" style={{ marginTop: 10 }}>Folder: <code>{folder}</code></div>}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------
function JobStatus({ job }) {
  const isDone = job.status === 'done'
  const isError = job.status === 'error'
  const cls = isDone ? 'ok' : isError ? 'err' : 'warn'

  let detail = ''
  if (job.status === 'running') {
    if (job.progress?.step) detail = `${job.progress.step}…`
    else if (job.progress)
      detail = `processed ${job.progress.processed || 0}, matched ${job.progress.matched || 0}`
    else detail = 'running…'
  } else if (isDone && job.result) {
    if (job.kind === 'attendance') {
      detail = `${job.result.people} ${job.result.people === 1 ? 'person' : 'people'}`
    } else if (job.kind === 'report') {
      detail = `${job.result.rows} rows · ${job.result.matched} matched · ${job.result.unknown} unknown`
    } else {
      detail = `processed ${job.result.processed}, matched ${job.result.matched}, unknown ${job.result.unknown}`
    }
  } else if (isError) {
    detail = job.error || 'failed'
  }

  return (
    <div style={{
      marginTop: 14, padding: '10px 14px',
      background: '#0f0f15', border: '1px solid var(--panel-border)',
      borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span className={`pill ${cls}`}>{job.status}</span>
      <span style={{ flex: 1, fontSize: 13 }}>{job.kind}: {detail}</span>
      {isDone && (job.kind === 'report' || job.kind === 'attendance') && job.result?.output_name && (
        <button
          className="btn-primary btn-sm"
          onClick={() => window.open(reportDownloadUrl(job.result.output_name), '_blank')}
        >
          Download
        </button>
      )}
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