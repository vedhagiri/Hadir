import { useCallback, useEffect, useRef, useState } from 'react'
import { api, knownPhotoUrl } from '../api'

/**
 * Known People page:
 *   - List of enrolled people with their photo counts
 *   - Click a person → expand to show photos + allow delete/upload
 *   - Add new person button
 *   - Drag-drop upload area (active when a person is expanded)
 *
 * Photos can also be managed by dropping files directly into
 * known_people/<n>/ on disk. Clicking "Reload from folder" rebuilds
 * embeddings for any manually-added photos.
 */
export default function KnownPeoplePage() {
  const [people, setPeople] = useState([])
  const [folder, setFolder] = useState('')
  const [expanded, setExpanded] = useState(null) // person name
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [reloading, setReloading] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.listKnownPeople()
      setPeople(data.people || [])
      setFolder(data.folder || '')
      setError(null)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleAddPerson = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      await api.createKnownPerson(name)
      setNewName(''); setAdding(false)
      setExpanded(name)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  const handleDeletePerson = async (name) => {
    if (!confirm(`Delete "${name}" and all their reference photos?`)) return
    try {
      await api.deleteKnownPerson(name)
      if (expanded === name) setExpanded(null)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  const handleDeletePhoto = async (name, filename) => {
    if (!confirm(`Delete photo "${filename}"?`)) return
    try {
      await api.deleteKnownPhoto(name, filename)
      await load()
    } catch (err) {
      setError(err.message)
    }
  }

  const handleUpload = async (name, files) => {
    if (!files || files.length === 0) return
    setUploading(true); setError(null)
    try {
      for (const file of files) {
        await api.uploadKnownPhoto(name, file)
      }
      await load()
    } catch (err) {
      setError(err.message)
    } finally {
      setUploading(false)
    }
  }

  const handleReload = async () => {
    setReloading(true); setError(null)
    try {
      const r = await api.reloadKnownPeople()
      await load()
      if (r.skipped && r.skipped.length > 0) {
        setError(`Reload skipped: ${r.skipped.join(', ')}`)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setReloading(false)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Known people</h1>
          <div className="page-subtitle">
            Upload 3–5 reference photos per person. Mix angles (front, left profile, right profile)
            for best recognition across camera angles.
          </div>
        </div>
        <div className="page-actions">
          <button className="btn-ghost btn-sm" onClick={handleReload} disabled={reloading}>
            {reloading ? 'Reloading…' : 'Reload from folder'}
          </button>
          <button className="btn-primary btn-sm" onClick={() => setAdding(true)}>
            + Add person
          </button>
        </div>
      </div>

      <div className="panel">
        {error && <div className="error-msg">{error}</div>}

        {adding && (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="col-wide">
              <label>New person name</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Alice"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddPerson() }}
              />
            </div>
            <button className="btn-primary" onClick={handleAddPerson}>Create</button>
            <button className="btn-ghost" onClick={() => { setAdding(false); setNewName('') }}>
              Cancel
            </button>
          </div>
        )}

        {people.length === 0 ? (
          <div className="empty-big">
            <div className="empty-big-icon">◎</div>
            <div className="empty-big-title">No people enrolled yet</div>
            <div className="empty-big-hint">
              Click <strong>Add person</strong> above, then upload their photos.
              You can also drop folders directly into <code>{folder}</code>.
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {people.map((p) => (
              <PersonRow
                key={p.name}
                person={p}
                expanded={expanded === p.name}
                onToggle={() => setExpanded(expanded === p.name ? null : p.name)}
                onUpload={(files) => handleUpload(p.name, files)}
                onDeletePerson={() => handleDeletePerson(p.name)}
                onDeletePhoto={(fname) => handleDeletePhoto(p.name, fname)}
                uploading={uploading}
              />
            ))}
          </div>
        )}

        {people.length > 0 && (
          <div className="hint" style={{ marginTop: 14 }}>
            Folder: <code>{folder}</code>
          </div>
        )}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------
// PersonRow — collapsible row with photos + upload drop zone
// -------------------------------------------------------------------
function PersonRow({ person, expanded, onToggle, onUpload, onDeletePerson, onDeletePhoto, uploading }) {
  const fileInputRef = useRef(null)
  const [dragActive, setDragActive] = useState(false)

  const handleDrop = (e) => {
    e.preventDefault(); e.stopPropagation()
    setDragActive(false)
    const files = [...(e.dataTransfer?.files || [])]
      .filter((f) => f.type.startsWith('image/'))
    if (files.length > 0) onUpload(files)
  }

  return (
    <div className="person-row">
      <div className="person-row-head" onClick={onToggle}>
        <div style={{ flex: 1 }}>
          <div className="person-row-name">
            {person.name}{' '}
            {!person.embedded && person.n_photos > 0 && (
              <span className="pill warn" style={{ fontSize: 10, padding: '1px 6px' }}>
                needs reload
              </span>
            )}
          </div>
          <div className="person-row-meta">
            {person.n_photos} photo{person.n_photos === 1 ? '' : 's'}
          </div>
        </div>
        <button
          className="btn-ghost btn-sm"
          onClick={(e) => { e.stopPropagation(); onDeletePerson() }}
        >
          Delete
        </button>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
          {expanded ? '▾' : '▸'}
        </span>
      </div>

      {expanded && (
        <div className="person-row-body">
          {person.photos.length > 0 && (
            <div className="face-grid" style={{ marginBottom: 10 }}>
              {person.photos.map((ph) => (
                <div key={ph} style={{ position: 'relative' }}>
                  <img
                    src={knownPhotoUrl(person.name, ph)}
                    alt={ph}
                    title={ph}
                    onClick={() => window.open(knownPhotoUrl(person.name, ph), '_blank')}
                  />
                  <button
                    className="btn-ghost btn-sm"
                    style={{
                      position: 'absolute', top: 2, right: 2,
                      padding: '1px 6px', fontSize: 10,
                      background: 'rgba(0,0,0,0.7)',
                    }}
                    onClick={() => onDeletePhoto(ph)}
                    title="Delete photo"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div
            className={'dropzone' + (dragActive ? ' active' : '')}
            onClick={() => fileInputRef.current?.click()}
            onDragEnter={(e) => { e.preventDefault(); setDragActive(true) }}
            onDragOver={(e) => { e.preventDefault(); setDragActive(true) }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
          >
            <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              {uploading ? 'Uploading…' : 'Drag photos here, or click to select'}
            </div>
            <div className="hint" style={{ marginTop: 4 }}>
              Tip: 3–5 varied photos per person (front + sides) give the best recognition
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              onUpload([...e.target.files])
              e.target.value = ''
            }}
          />
        </div>
      )}
    </div>
  )
}