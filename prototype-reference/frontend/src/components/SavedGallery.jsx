import { savedFileUrl } from '../api'

/**
 * Gallery of saved snapshot files from disk.
 * Takes the {files, total_dir} response from /api/saved as `data`.
 *
 * Clicking a thumbnail opens the full-size JPEG in a new tab.
 */
export default function SavedGallery({ data, onRefresh }) {
  const files = data?.files || []
  const totalDir = data?.total_dir || ''

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Saved snapshots</span>
        <button className="btn-ghost" onClick={onRefresh}>Refresh</button>
      </div>

      <div className="saved-grid">
        {files.length === 0 ? (
          <div className="crops-empty">No saved snapshots yet.</div>
        ) : (
          files.map((f) => (
            <img
              key={`${f.day}/${f.name}`}
              src={savedFileUrl(f.url)}
              title={`${f.day} · ${f.name} · ${f.size_kb} KB`}
              onClick={() => window.open(savedFileUrl(f.url), '_blank')}
              alt={f.name}
              loading="lazy"
            />
          ))
        )}
      </div>

      {totalDir && <div className="save-path">Folder: {totalDir}</div>}
    </div>
  )
}
