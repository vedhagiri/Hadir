import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { usePolling } from '../hooks/usePolling'

import CameraList from '../components/CameraList'
import CameraForm from '../components/CameraForm'
import VideoView from '../components/VideoView'
import StatusBar from '../components/StatusBar'
import SettingsPanel from '../components/SettingsPanel'
import EventsList from '../components/EventsList'
import EventDetail from '../components/EventDetail'

/**
 * Cameras page — single-camera-at-a-time capture workflow.
 *
 * Round 4 UX changes:
 *   - Prominent Start / Stop buttons in the page header
 *   - Clicking a camera STILL starts streaming immediately (user's preferred UX)
 *   - The last-started camera is remembered so Start works after Stop
 *   - Clear visual state for "selected" vs. "streaming" vs. "neither"
 */
export default function CamerasPage() {
  const [cameras, setCameras] = useState([])
  const [camerasError, setCamerasError] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [editingCamera, setEditingCamera] = useState(null)
  const [streamingCameraId, setStreamingCameraId] = useState(null)
  // Remembers the last camera we started, so Start button works after Stop
  const [lastStartedId, setLastStartedId] = useState(null)
  const [streamKey, setStreamKey] = useState(0)
  const [streamError, setStreamError] = useState(null)
  const [openEventId, setOpenEventId] = useState(null)

  const loadCameras = useCallback(async () => {
    try {
      const list = await api.listCameras()
      setCameras(list)
      setCamerasError(null)
    } catch (err) {
      setCamerasError(err.message)
    }
  }, [])
  useEffect(() => { loadCameras() }, [loadCameras])

  const { data: streamState } = usePolling(
    api.streamStatus, 1000, streamingCameraId != null,
  )

  // If backend reports stream stopped (e.g. RTSP failure), clear UI state
  useEffect(() => {
    if (!streamState) return
    if (!streamState.running && streamingCameraId != null) {
      setStreamingCameraId(null)
    }
  }, [streamState, streamingCameraId])

  const startCameraById = async (camId) => {
    const cam = cameras.find((c) => c.id === camId)
    if (!cam) return
    if (!cam.enabled) {
      setStreamError(`${cam.name} is disabled — edit to enable it.`)
      return
    }
    setStreamError(null)
    try {
      const result = await api.startStream(cam.id)
      if (!result.ok) throw new Error(result.error || 'start failed')
      const status = result.state?.stats?.status
      if (status === 'failed to open stream') {
        throw new Error('Could not open RTSP stream — check URL and credentials')
      }
      setStreamingCameraId(cam.id)
      setLastStartedId(cam.id)
      setStreamKey((k) => k + 1)
    } catch (err) {
      setStreamError(err.message)
      setStreamingCameraId(null)
    }
  }

  const handleSelectCamera = async (cam) => {
    // Click while this one is already streaming = toggle off
    if (streamingCameraId === cam.id) {
      await handleStop()
      return
    }
    await startCameraById(cam.id)
  }

  const handleStart = async () => {
    // Start button uses the last-started camera, or the first enabled one
    const targetId =
      lastStartedId ??
      cameras.find((c) => c.enabled)?.id
    if (targetId != null) {
      await startCameraById(targetId)
    } else {
      setStreamError('No camera selected. Click a camera in the list to start.')
    }
  }

  const handleStop = async () => {
    try { await api.stopStream() } catch (err) { console.error(err) }
    setStreamingCameraId(null)
  }

  const handleAddCamera = () => { setEditingCamera(null); setShowForm(true) }
  const handleEditCamera = (cam) => { setEditingCamera(cam); setShowForm(true) }

  const handleDeleteCamera = async (cam) => {
    if (!confirm(`Delete camera "${cam.name}"? Historical events will remain.`)) return
    try {
      await api.deleteCamera(cam.id)
      if (streamingCameraId === cam.id) setStreamingCameraId(null)
      if (lastStartedId === cam.id) setLastStartedId(null)
      await loadCameras()
    } catch (err) {
      alert('Delete failed: ' + err.message)
    }
  }

  const handleSubmitCamera = async (data) => {
    if (editingCamera) {
      await api.updateCamera(editingCamera.id, data)
      if (streamingCameraId === editingCamera.id) setStreamingCameraId(null)
    } else {
      await api.createCamera(data)
    }
    setShowForm(false)
    setEditingCamera(null)
    await loadCameras()
  }

  const streamingCamera = cameras.find((c) => c.id === streamingCameraId)
  const lastStartedCamera = cameras.find((c) => c.id === lastStartedId)
  const isStreaming = streamingCameraId != null

  // Start is enabled if NOT streaming and we have something to start
  const canStart = !isStreaming && (lastStartedCamera || cameras.some((c) => c.enabled))

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Cameras</h1>
          <div className="page-subtitle">
            {isStreaming
              ? `Streaming ${streamingCamera?.name}`
              : lastStartedCamera
                ? `Ready to resume ${lastStartedCamera.name}. Or click any camera below.`
                : 'Click a camera below to start streaming.'}
          </div>
        </div>
        <div className="page-actions">
          <button
            className="btn-primary"
            onClick={handleStart}
            disabled={!canStart}
            title={
              isStreaming
                ? 'Already streaming'
                : lastStartedCamera
                  ? `Start ${lastStartedCamera.name}`
                  : 'No camera selected yet'
            }
          >
            ▶ Start feed
          </button>
          <button
            className="btn-danger"
            onClick={handleStop}
            disabled={!isStreaming}
          >
            ■ Stop feed
          </button>
          {isStreaming && (
            <span className="pill ok" style={{ marginLeft: 4 }}>
              ● {streamingCamera?.name}
            </span>
          )}
        </div>
      </div>

      {camerasError && (
        <div className="error-msg">
          Could not load cameras: {camerasError}
          <button className="btn-ghost btn-sm" onClick={loadCameras} style={{ marginLeft: 10 }}>
            Retry
          </button>
        </div>
      )}

      <div className="layout-2col">
        <div>
          <CameraList
            cameras={cameras}
            activeId={streamingCameraId}
            onSelect={handleSelectCamera}
            onEdit={handleEditCamera}
            onDelete={handleDeleteCamera}
            onAdd={handleAddCamera}
          />
          <SettingsPanel />
        </div>

        <div>
          <VideoView
            streaming={isStreaming}
            streamKey={streamKey}
            cameraName={streamingCamera?.name}
          />
          <StatusBar state={streamState} />
          {streamError && (
            <div className="error-msg" style={{ marginTop: 10 }}>
              Stream error: {streamError}
            </div>
          )}
        </div>
      </div>

      <EventsList
        selectedCameraId={streamingCameraId}
        onOpenEvent={setOpenEventId}
      />

      {showForm && (
        <CameraForm
          initial={editingCamera}
          onSubmit={handleSubmitCamera}
          onCancel={() => { setShowForm(false); setEditingCamera(null) }}
        />
      )}

      {openEventId && (
        <EventDetail
          eventId={openEventId}
          onClose={() => setOpenEventId(null)}
        />
      )}
    </div>
  )
}