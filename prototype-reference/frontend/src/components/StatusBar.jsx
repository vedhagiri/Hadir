/**
 * Displays capture stats for the currently active camera.
 *
 * Round 4: split-thread architecture means we have two FPS numbers —
 *   fps_reader   = how fast we're pulling frames from the RTSP stream
 *   fps_analyzer = how fast we're actually running face detection
 *
 * Healthy baseline: reader ~15-30 (camera native), analyzer 3-6.
 * If reader is much lower than expected, network or camera is the bottleneck.
 * If analyzer is 0 most of the time, motion skip is working (nothing happening).
 */
export default function StatusBar({ state }) {
  if (!state?.running) {
    return (
      <div className="statusbar">
        <span className="pill">Status: idle</span>
      </div>
    )
  }

  const s = state.stats || {}
  const status = s.status || 'starting'
  const statusClass =
    status === 'streaming'     ? 'ok' :
    status === 'reconnecting'  ? 'warn' :
    status === 'stopped'       ? '' :
    'err'

  return (
    <div className="statusbar">
      <span className={`pill ${statusClass}`}>Status: {status}</span>
      <span className="pill" title="Frames pulled from camera per second">
        Reader: {s.fps_reader ?? '—'} fps
      </span>
      <span className="pill" title="Frames actually analyzed per second">
        Analyzer: {s.fps_analyzer ?? '—'} fps
      </span>
      <span className="pill">Faces in frame: {s.faces_in_frame ?? 0}</span>
      <span className="pill info">Active tracks: {s.active_tracks ?? 0}</span>
      <span className="pill info">Events: {s.total_events ?? 0}</span>
      <span className="pill info">Faces saved: {s.total_faces_saved ?? 0}</span>
      {s.motion_skipped > 0 && (
        <span className="pill" title="Detection skipped because no motion was seen">
          Motion-skipped: {s.motion_skipped}
        </span>
      )}
      {s.last_error && (
        <span className="pill err" title={s.last_error}>
          Error: {String(s.last_error).slice(0, 40)}
        </span>
      )}
    </div>
  )
}