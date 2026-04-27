import { useEffect, useState } from 'react'
import DashboardPage from './pages/DashboardPage'
import CamerasPage from './pages/CamerasPage'
import KnownPeoplePage from './pages/KnownPeoplePage'
import ReportsPage from './pages/ReportsPage'

const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: '◉' },
  { id: 'cameras', label: 'Cameras',   icon: '▣' },
  { id: 'people', label: 'Known people', icon: '◎' },
  { id: 'reports', label: 'Reports',   icon: '▤' },
]

export default function App() {
  const [tab, setTab] = useState(() => {
    const hash = window.location.hash.slice(1)
    return NAV.map((n) => n.id).includes(hash) ? hash : 'dashboard'
  })

  useEffect(() => { window.location.hash = tab }, [tab])

  // Stop stream on tab close
  useEffect(() => {
    const onUnload = () => {
      try {
        navigator.sendBeacon?.(
          `${import.meta.env.VITE_API_BASE || 'http://localhost:5006'}/api/stream/stop`
        )
      } catch { /* ignore */ }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-title">Camera Detection</div>
          <div className="brand-sub">Multi-camera attendance</div>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={'nav-item' + (tab === n.id ? ' active' : '')}
              onClick={() => setTab(n.id)}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main">
        {tab === 'dashboard' && <DashboardPage onNavigate={setTab} />}
        {tab === 'cameras' && <CamerasPage />}
        {tab === 'people' && <KnownPeoplePage />}
        {tab === 'reports' && <ReportsPage />}
      </main>
    </div>
  )
}