/* Shell — sidebar, topbar, role-aware navigation */

const NAV = {
  Admin: [
    { section: 'Overview' },
    { id: 'dashboard', label: 'Dashboard', icon: 'home' },
    { id: 'live', label: 'Live Capture', icon: 'camera', badge: 'LIVE' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar' },
    { section: 'Operations' },
    { id: 'cameras', label: 'Cameras', icon: 'camera', badge: '8' },
    { id: 'employees', label: 'Employees', icon: 'users', badge: '106' },
    { id: 'enrollment', label: 'Enrollment', icon: 'upload' },
    { id: 'policies', label: 'Shift Policies', icon: 'clock' },
    { id: 'leave-policy', label: 'Leave & Calendar', icon: 'calendar' },
    { section: 'Attendance' },
    { id: 'daily-attendance', label: 'Daily Attendance', icon: 'fileText' },
    { id: 'camera-logs', label: 'Camera Logs', icon: 'camera' },
    { id: 'pipeline', label: 'How it works', icon: 'sparkles' },
    { section: 'Workflow' },
    { id: 'approvals', label: 'Approvals', icon: 'inbox', badge: '4' },
    { id: 'reports', label: 'Reports', icon: 'fileText' },
    { id: 'employee-report', label: 'Employee report', icon: 'user' },
    { id: 'mgr-assign', label: 'Manager assignments', icon: 'users' },
    { id: 'audit', label: 'Audit Log', icon: 'shield' },
    { section: 'System' },
    { id: 'system', label: 'System & Infra', icon: 'activity' },
    { id: 'api-docs', label: 'API Reference', icon: 'fileText' },
    { id: 'settings', label: 'Settings & custom fields', icon: 'settings' },
  ],
  HR: [
    { section: 'Overview' },
    { id: 'dashboard', label: 'Dashboard', icon: 'home' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar' },
    { section: 'People' },
    { id: 'employees', label: 'Employees', icon: 'users', badge: '106' },
    { id: 'enrollment', label: 'Enrollment', icon: 'upload' },
    { id: 'employee-report', label: 'Employee report', icon: 'user' },
    { section: 'Workflow' },
    { id: 'approvals', label: 'Approvals', icon: 'inbox', badge: '4' },
    { id: 'policies', label: 'Shift Policies', icon: 'clock' },
    { id: 'leave-policy', label: 'Leave & Calendar', icon: 'calendar' },
    { id: 'reports', label: 'Reports', icon: 'fileText' },
    { section: 'Attendance' },
    { id: 'daily-attendance', label: 'Daily Attendance', icon: 'fileText' },
    { id: 'camera-logs', label: 'Camera Logs', icon: 'camera' },
    { id: 'mgr-assign', label: 'Manager assignments', icon: 'users' },
    { id: 'pipeline', label: 'How it works', icon: 'sparkles' },
    { id: 'api-docs', label: 'API Reference', icon: 'fileText' },
    { section: 'System' },
    { id: 'settings', label: 'Settings & custom fields', icon: 'settings' },
    { section: 'Personal' },
    { id: 'my-attendance', label: 'My Attendance', icon: 'calendar' },
  ],
  Manager: [
    { section: 'Team' },
    { id: 'dashboard', label: 'Team Today', icon: 'home' },
    { id: 'team-attendance', label: 'Team Attendance', icon: 'users' },
    { id: 'calendar', label: 'Team Calendar', icon: 'calendar' },
    { id: 'approvals', label: 'Approvals', icon: 'inbox', badge: '2' },
    { id: 'daily-attendance', label: 'Daily Attendance', icon: 'fileText' },
    { section: 'Personal' },
    { id: 'my-attendance', label: 'My Attendance', icon: 'calendar' },
    { id: 'my-requests', label: 'My Requests', icon: 'clipboard' },
  ],
  Employee: [
    { section: 'Me' },
    { id: 'dashboard', label: 'Today', icon: 'home' },
    { id: 'my-attendance', label: 'Attendance', icon: 'calendar' },
    { id: 'calendar', label: 'Calendar view', icon: 'calendar' },
    { id: 'my-requests', label: 'Requests', icon: 'clipboard' },
    { id: 'my-profile', label: 'Profile & Photo', icon: 'user' },
  ],
};

const ROLE_USER = {
  Admin: { name: 'Tariq Al-Shukaili', initials: 'TS', sub: 'ADMIN · Omran HQ' },
  HR: { name: 'Aisha Al-Habsi', initials: 'AH', sub: 'HR · Head Office' },
  Manager: { name: 'Sultan Al-Busaidi', initials: 'SB', sub: 'MANAGER · Operations' },
  Employee: { name: 'Fatima Al-Kindi', initials: 'FK', sub: 'EMPLOYEE · Operations' },
};

const CRUMBS = {
  dashboard: ['Hadir', 'Dashboard'],
  live: ['Hadir', 'Live Capture'],
  cameras: ['Hadir', 'Cameras'],
  employees: ['Hadir', 'People', 'Employees'],
  enrollment: ['Hadir', 'People', 'Enrollment'],
  policies: ['Hadir', 'Configuration', 'Shift Policies'],
  approvals: ['Hadir', 'Workflow', 'Approvals'],
  reports: ['Hadir', 'Reports'],
  audit: ['Hadir', 'System', 'Audit Log'],
  settings: ['Hadir', 'System', 'Settings'],
  'my-attendance': ['Hadir', 'Me', 'Attendance'],
  'team-attendance': ['Hadir', 'Team', 'Attendance'],
  'my-requests': ['Hadir', 'Me', 'Requests'],
  'my-profile': ['Hadir', 'Me', 'Profile'],
  'calendar': ['Hadir', 'Attendance', 'Calendar'],
  'employee-report': ['Hadir', 'Reports', 'Employee report'],
  'leave-policy': ['Hadir', 'Configuration', 'Leave & Calendar'],
  'daily-attendance': ['Hadir', 'Attendance', 'Daily'],
  'camera-logs': ['Hadir', 'Attendance', 'Camera logs'],
  'mgr-assign': ['Hadir', 'People', 'Manager assignments'],
  'pipeline': ['Hadir', 'How it works'],
  'system': ['Hadir', 'System', 'Infrastructure'],
  'api-docs': ['Hadir', 'Developers', 'API Reference'],
};

function Sidebar({ role, setRole, page, setPage }) {
  const items = NAV[role];
  const user = ROLE_USER[role];
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">ح</div>
        <div className="brand-name">Hadir</div>
        <div className="brand-tag">v1.0</div>
      </div>
      <div className="topbar-search" style={{ width: '100%', margin: '0 0 6px' }}>
        <Icon name="search" size={13} />
        <input placeholder="Search…" />
        <span className="kbd">⌘K</span>
      </div>
      {items.map((it, i) => {
        if (it.section) return <div key={i} className="nav-label" style={{ marginTop: i === 0 ? 8 : 12 }}>{it.section}</div>;
        const active = it.id === page;
        return (
          <div key={it.id} className={`nav-item ${active ? 'active' : ''}`} onClick={() => setPage(it.id)}>
            <Icon name={it.icon} size={14} />
            <span>{it.label}</span>
            {it.badge && <span className="nav-badge">{it.badge}</span>}
          </div>
        );
      })}
      <div className="sidebar-footer">
        <RoleSwitcher role={role} setRole={setRole} user={user} />
      </div>
    </aside>
  );
}

function RoleSwitcher({ role, setRole, user }) {
  const [open, setOpen] = React.useState(false);
  const roles = ['Admin', 'HR', 'Manager', 'Employee'];
  return (
    <div style={{ position: 'relative' }}>
      <button className="role-switcher" onClick={() => setOpen(v => !v)}>
        <div className="avatar">{user.initials}</div>
        <div className="role-col">
          <span className="role-label">{user.name}</span>
          <span className="role-sub">{user.sub}</span>
        </div>
        <Icon name="chevronsUpDown" size={13} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 9,
          boxShadow: 'var(--shadow-lg)', padding: 4, zIndex: 30
        }}>
          <div style={{ padding: '6px 10px 4px', fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>View as</div>
          {roles.map(r => (
            <div key={r} className="nav-item" onClick={() => { setRole(r); setOpen(false); }} style={{ padding: '6px 10px' }}>
              <Icon name={r === role ? 'check' : 'user'} size={13} />
              <span>{r}</span>
              {r === role && <span className="nav-badge">current</span>}
            </div>
          ))}
          <div className="hr" style={{ margin: '4px 0' }} />
          <div className="nav-item" style={{ padding: '6px 10px', color: 'var(--text-tertiary)' }}>
            <Icon name="logout" size={13} /><span>Sign out</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Topbar({ page, role, rtl, setRtl, theme, setTheme, onOpenNew, onMobileNav }) {
  const crumbs = CRUMBS[page] || ['Hadir', page];
  return (
    <div className="topbar">
      <button className="icon-btn mobile-only" onClick={onMobileNav} title="Menu">
        <Icon name="menu" size={16} />
      </button>
      <div className="crumbs">
        {crumbs.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="crumb-sep"><Icon name="chevronRight" size={11} /></span>}
            <span className={i === crumbs.length - 1 ? 'crumb-current' : ''}>{c}</span>
          </React.Fragment>
        ))}
      </div>
      <div className="topbar-search">
        <Icon name="search" size={13} />
        <input placeholder={rtl ? 'ابحث عن موظف أو سجل…' : 'Find employee, record, camera…'} />
        <span className="kbd">⌘K</span>
      </div>
      <button className="icon-btn" title={rtl ? 'English' : 'العربية'} onClick={() => setRtl(v => !v)}>
        <span style={{ fontSize: 11, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>{rtl ? 'EN' : 'ع'}</span>
      </button>
      <button className="icon-btn" title="Theme" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
      </button>
      <button className="icon-btn" title="Notifications">
        <Icon name="bell" size={14} />
      </button>
      <button className="btn btn-primary btn-sm" onClick={onOpenNew}>
        <Icon name="plus" size={12} />New request
      </button>
    </div>
  );
}

window.Shell = { Sidebar, Topbar, NAV, CRUMBS, ROLE_USER };
