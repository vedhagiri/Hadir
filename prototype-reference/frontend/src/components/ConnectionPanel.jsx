import { useState } from 'react'

export default function ConnectionPanel({ onConnect, onStop, disabled }) {
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const handleConnect = () => {
    if (!url.trim()) {
      alert('Please enter a camera URL')
      return
    }
    onConnect({ url: url.trim(), username: username.trim(), password: password.trim() })
  }

  return (
    <div className="panel">
      <div className="row">
        <div className="col-wide">
          <label>Camera RTSP URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="rtsp://192.168.0.210:554/video/live?channel=1&subtype=0"
          />
          <div className="hint">
            CP Plus: rtsp://IP:554/cam/realmonitor?channel=1&amp;subtype=0 (main) or subtype=1 (sub)
          </div>
        </div>

        <div className="col">
          <label>Username</label>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin"
          />
        </div>

        <div className="col">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>

      <div className="row">
        <button className="btn-connect" onClick={handleConnect} disabled={disabled}>
          Connect
        </button>
        <button className="btn-stop" onClick={onStop}>
          Stop
        </button>
      </div>
    </div>
  )
}
