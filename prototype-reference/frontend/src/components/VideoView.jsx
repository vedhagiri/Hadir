import { previewStreamUrl } from '../api'

/**
 * Shows the MJPEG preview of the currently streaming camera.
 * `streamKey` changing forces the <img> to remount, closing any stale stream.
 */
export default function VideoView({ streaming, streamKey, cameraName }) {
  if (!streaming) {
    return (
      <div className="video-wrap">
        <div className="placeholder">
          Select a camera from the list to start streaming.
        </div>
      </div>
    )
  }

  return (
    <div className="video-wrap">
      <img
        key={streamKey}
        className="live"
        src={previewStreamUrl(true)}
        alt={`live preview of ${cameraName}`}
      />
    </div>
  )
}