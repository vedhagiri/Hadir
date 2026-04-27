/**
 * Horizontal strip of crops from the current frame.
 * Matches the original Flask UI — single row, scrolls horizontally on overflow.
 *
 * Each crop is a base64-encoded JPEG from /api/crops (already resized on the
 * server). We just plug it into an <img src="data:image/jpeg;base64,...">.
 */
export default function CropsStrip({ crops }) {
  const list = crops || []

  return (
    <div className="panel">
      <div className="panel-header">
        <span className="panel-title">Live crops (current frame)</span>
        <span className="panel-title">
          {list.length} crop{list.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="crops-strip">
        {list.length === 0 ? (
          <div className="crops-empty">No people detected right now.</div>
        ) : (
          list.map((c, i) => (
            <div className="crop-card" key={i}>
              <img
                src={`data:image/jpeg;base64,${c.img}`}
                alt={`person ${i + 1}`}
              />
              <span className="crop-conf">
                {(c.conf * 100).toFixed(0)}%
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
