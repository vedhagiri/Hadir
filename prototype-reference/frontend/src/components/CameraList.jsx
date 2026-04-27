/**
 * List of cameras. Clicking a camera calls onSelect (which starts/stops stream).
 * Edit/delete actions stopPropagation so they don't trigger selection.
 */
export default function CameraList({
  cameras,
  activeId,
  onSelect,
  onEdit,
  onDelete,
  onAdd,
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2 style={{ margin: 0 }}>Cameras</h2>
        <button className="btn-primary btn-sm" onClick={onAdd}>+ Add camera</button>
      </div>

      {cameras.length === 0 ? (
        <div className="empty">
          No cameras yet. Click <strong>Add camera</strong> to register one.
        </div>
      ) : (
        <div className="camera-list">
          {cameras.map((cam) => (
            <div
              key={cam.id}
              className={
                'camera-item' +
                (activeId === cam.id ? ' active' : '') +
                (cam.enabled ? '' : ' cam-disabled')
              }
              onClick={() => onSelect(cam)}
            >
              <div className="cam-info">
                <div className="cam-name">{cam.name}</div>
                <div className="cam-url" title={cam.url}>{cam.url}</div>
              </div>
              <div className="cam-actions">
                <button
                  className="btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); onEdit(cam) }}
                >
                  Edit
                </button>
                <button
                  className="btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); onDelete(cam) }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}