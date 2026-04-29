/* Login/SSO + App shell + tweaks */

function LoginScreen({ onLogin }) {
  return (
    <div style={{ height: '100vh', display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
      <div style={{ background: 'var(--bg)', display: 'flex', flexDirection: 'column', padding: '48px 64px' }}>
        <div className="flex items-center gap-2">
          <div className="brand-mark" style={{ width: 30, height: 30, borderRadius: 8 }}>ح</div>
          <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: '-0.01em' }}>Maugood</div>
        </div>
        <div style={{ margin: 'auto 0', maxWidth: 400 }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontWeight: 500, fontSize: 38, letterSpacing: '-0.02em', lineHeight: 1.1, margin: 0 }}>
            Welcome back.
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: 10, lineHeight: 1.5 }}>
            Sign in with your Omran account to access attendance, approvals and reports.
          </p>
          <button onClick={onLogin} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '10px 16px', marginTop: 24, fontSize: 13 }}>
            <svg width="16" height="16" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
            Continue with Microsoft Entra ID
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '24px 0', color: 'var(--text-tertiary)', fontSize: 11 }}>
            <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />OR<div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          </div>
          <div className="field" style={{ marginBottom: 10 }}>
            <label className="field-label">Work email</label>
            <input className="input" defaultValue="aisha.habsi@omran.om" />
          </div>
          <div className="field">
            <label className="field-label">Password</label>
            <input className="input" type="password" defaultValue="••••••••••" />
          </div>
          <button onClick={onLogin} className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 14, padding: '8px 16px' }}>Sign in with password</button>
          <div className="text-xs text-dim" style={{ marginTop: 16, textAlign: 'center' }}>
            Email/password login is for dev only. Admin may disable in production.
          </div>
        </div>
        <div className="text-xs text-dim" style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>© 2026 Muscat Tech Solutions · prepared for Omran</span>
          <span className="mono">v1.0 · build 417</span>
        </div>
      </div>
      <div style={{ background: 'linear-gradient(180deg, oklch(0.52 0.09 195), oklch(0.38 0.1 220))', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(circle at 30% 40%, rgba(255,255,255,0.15), transparent 55%)' }} />
        <div style={{ position: 'absolute', inset: 0, backgroundImage: 'radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px)', backgroundSize: '20px 20px' }} />
        <div style={{ position: 'absolute', bottom: 48, left: 48, right: 48, color: 'white' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 32, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1.15 }}>
            Presence, not paperwork.
          </div>
          <div style={{ fontSize: 13.5, marginTop: 12, opacity: 0.85, lineHeight: 1.55, maxWidth: 420 }}>
            Camera-based attendance for Omran. Face identification, shift policies, approvals and reports — running quietly in the background.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            {['Entra ID SSO', 'Oman PDPL', 'On-prem · Ubuntu', 'Arabic-ready'].map(t => (
              <span key={t} style={{ padding: '4px 10px', borderRadius: 999, background: 'rgba(255,255,255,0.12)', color: 'white', fontSize: 11, border: '1px solid rgba(255,255,255,0.2)' }}>{t}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "teal",
  "theme": "light",
  "density": "comfortable",
  "rtl": false,
  "hideFaces": false,
  "role": "HR"
}/*EDITMODE-END*/;

const ACCENTS = {
  teal:    { name: 'Teal',   c: 'oklch(0.52 0.09 195)', h: 195 },
  indigo:  { name: 'Indigo', c: 'oklch(0.52 0.14 265)', h: 265 },
  emerald: { name: 'Emerald',c: 'oklch(0.52 0.12 160)', h: 160 },
  amber:   { name: 'Amber',  c: 'oklch(0.58 0.14 60)',  h: 60  },
  rose:    { name: 'Rose',   c: 'oklch(0.55 0.16 15)',  h: 15  },
  slate:   { name: 'Slate',  c: 'oklch(0.42 0.03 240)', h: 240 },
};

function App() {
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);
  const setTweaks = React.useCallback(
    (edits) => Object.entries(edits).forEach(([k, v]) => setTweak(k, v)),
    [setTweak]
  );
  const [loggedIn, setLoggedIn] = React.useState(false);
  const [page, setPage] = React.useState('dashboard');
  const [openRequest, setOpenRequest] = React.useState(null);
  const [openRecord, setOpenRecord] = React.useState(null);
  const [openForm, setOpenForm] = React.useState(null); // 'camera' | 'request' | 'report'
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [mgrAssignOpen, setMgrAssignOpen] = React.useState(false);

  const role = tweaks.role;
  const theme = tweaks.theme;
  const rtl = tweaks.rtl;
  const density = tweaks.density;
  const hideFaces = tweaks.hideFaces;

  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-density', density);
    document.documentElement.setAttribute('dir', rtl ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', rtl ? 'ar' : 'en');
    const a = ACCENTS[tweaks.accent] || ACCENTS.teal;
    document.documentElement.style.setProperty('--accent', `oklch(0.52 0.09 ${a.h})`);
    document.documentElement.style.setProperty('--accent-hover', `oklch(0.46 0.09 ${a.h})`);
    document.documentElement.style.setProperty('--accent-soft', theme === 'dark' ? `oklch(0.22 0.04 ${a.h})` : `oklch(0.96 0.02 ${a.h})`);
    document.documentElement.style.setProperty('--accent-border', theme === 'dark' ? `oklch(0.32 0.06 ${a.h})` : `oklch(0.85 0.05 ${a.h})`);
    document.documentElement.style.setProperty('--accent-text', theme === 'dark' ? `oklch(0.76 0.09 ${a.h})` : `oklch(0.38 0.09 ${a.h})`);
  }, [theme, density, rtl, tweaks.accent]);

  // When role changes, default to its home page
  React.useEffect(() => {
    const homes = { Admin: 'dashboard', HR: 'dashboard', Manager: 'dashboard', Employee: 'dashboard' };
    setPage(homes[role]);
  }, [role]);

  if (!loggedIn) return <LoginScreen onLogin={() => setLoggedIn(true)} />;

  const { Sidebar, Topbar } = window.Shell;
  const { HRDashboard, AdminDashboard, ManagerDashboard } = window.Dashboards;
  const { EmployeeDashboard } = window.Employee;
  const { LiveCapture, ApprovalsPage, RequestDrawer, RecordDrawer, PoliciesPage, EnrollmentPage, ReportsPage, EmployeesPage } = window.Pages;
  const { NewCameraDrawer, NewRequestDrawer, NewReportDrawer, AttendanceCalendarPage, EmployeeReportPage, CustomFieldsPage } = window.Enhancements;
  const { LeavePolicyPage, DailyAttendancePage, CameraLogsPage, ManagerAssignDrawer, PipelinePage } = window.Enhancements2;
  const { ReportsPageV2, EmployeesPageV2, ApiDocsPage, SystemPage } = window.Enhancements3;

  const onOpenRecord = (person, day = null) => setOpenRecord({ person, day });
  const onOpenRequest = (req) => setOpenRequest(req);

  let content = null;
  if (page === 'dashboard') {
    if (role === 'HR') content = <HRDashboard hideFaces={hideFaces} onOpenRequest={onOpenRequest} onOpenRecord={(p) => onOpenRecord(p)} />;
    else if (role === 'Admin') content = <AdminDashboard hideFaces={hideFaces} />;
    else if (role === 'Manager') content = <ManagerDashboard hideFaces={hideFaces} onOpenRecord={onOpenRecord} />;
    else content = <EmployeeDashboard hideFaces={hideFaces} onOpenRecord={onOpenRecord} />;
  }
  else if (page === 'live') content = <LiveCapture hideFaces={hideFaces} />;
  else if (page === 'cameras') content = <AdminDashboard hideFaces={hideFaces} />;
  else if (page === 'employees') content = <EmployeesPageV2 hideFaces={hideFaces} onOpenRecord={onOpenRecord} />;
  else if (page === 'enrollment') content = <EnrollmentPage hideFaces={hideFaces} />;
  else if (page === 'policies') content = <PoliciesPage hideFaces={hideFaces} />;
  else if (page === 'approvals' || page === 'my-requests') content = <ApprovalsPage role={role} hideFaces={hideFaces} onOpenRequest={onOpenRequest} />;
  else if (page === 'reports') content = <ReportsPageV2 onNewReport={() => setOpenForm('report')} />;
  else if (page === 'calendar') content = <AttendanceCalendarPage hideFaces={hideFaces} onOpenRecord={onOpenRecord} defaultPerson={role === 'Employee' ? 'OM0045' : null} />;
  else if (page === 'employee-report') content = <EmployeeReportPage hideFaces={hideFaces} onOpenRecord={onOpenRecord} />;
  else if (page === 'leave-policy') content = <LeavePolicyPage />;
  else if (page === 'daily-attendance') content = <DailyAttendancePage hideFaces={hideFaces} />;
  else if (page === 'camera-logs') content = <CameraLogsPage hideFaces={hideFaces} />;
  else if (page === 'pipeline') content = <PipelinePage />;
  else if (page === 'system') content = <SystemPage />;
  else if (page === 'api-docs') content = <ApiDocsPage />;
  else if (page === 'mgr-assign') { content = <ManagerAssignLanding onOpen={() => setMgrAssignOpen(true)} />; }
  else if (page === 'settings') content = <CustomFieldsPage />;
  else if (page === 'my-attendance' || page === 'team-attendance' || page === 'my-profile') content = <EmployeeDashboard hideFaces={hideFaces} onOpenRecord={onOpenRecord} />;
  else if (page === 'audit') content = <AuditStub />;
  else content = <div className="empty">Page coming soon.</div>;

  const handleNewAction = () => {
    if (role === 'Admin' && (page === 'cameras' || page === 'dashboard' || page === 'live')) setOpenForm('camera');
    else if (page === 'reports') setOpenForm('report');
    else setOpenForm('request');
  };

  return (
    <div className={`app ${mobileNavOpen ? 'mobile-nav-open' : ''}`}>
      <Sidebar role={role} setRole={(r) => setTweaks({ role: r })} page={page} setPage={(p) => { setPage(p); setMobileNavOpen(false); }} />
      <div className="main">
        <Topbar page={page} role={role}
          rtl={rtl} setRtl={(fn) => setTweaks({ rtl: typeof fn === 'function' ? fn(rtl) : fn })}
          theme={theme} setTheme={(fn) => setTweaks({ theme: typeof fn === 'function' ? fn(theme) : fn })}
          onOpenNew={handleNewAction}
          onMobileNav={() => setMobileNavOpen(v => !v)} />
        <div className="content">
          <div className="content-wrap">{content}</div>
        </div>
        {(role === 'Employee' || role === 'Manager') && (
          <nav className="bottom-nav">
            {(role === 'Employee' ? [
              { id: 'dashboard', label: 'Today', icon: 'home' },
              { id: 'my-attendance', label: 'Attendance', icon: 'calendar' },
              { id: 'calendar', label: 'Calendar', icon: 'calendar' },
              { id: 'my-requests', label: 'Requests', icon: 'clipboard' },
              { id: 'my-profile', label: 'Me', icon: 'user' },
            ] : [
              { id: 'dashboard', label: 'Today', icon: 'home' },
              { id: 'team-attendance', label: 'Team', icon: 'users' },
              { id: 'calendar', label: 'Calendar', icon: 'calendar' },
              { id: 'approvals', label: 'Approve', icon: 'inbox' },
              { id: 'my-attendance', label: 'Me', icon: 'user' },
            ]).map(n => (
              <button key={n.id} className={`bn-item ${page === n.id ? 'active' : ''}`} onClick={() => setPage(n.id)}>
                <Icon name={n.icon} size={16} />
                <span>{n.label}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
      {openRequest && <RequestDrawer request={openRequest} onClose={() => setOpenRequest(null)} hideFaces={hideFaces} />}
      {openRecord && <RecordDrawer record={openRecord} onClose={() => setOpenRecord(null)} hideFaces={hideFaces} />}
      {openForm === 'camera' && <NewCameraDrawer onClose={() => setOpenForm(null)} />}
      {openForm === 'request' && <NewRequestDrawer role={role} currentUserId={role === 'Employee' ? 'OM0045' : null} onClose={() => setOpenForm(null)} />}
      {openForm === 'report' && <NewReportDrawer onClose={() => setOpenForm(null)} />}
      {mgrAssignOpen && <ManagerAssignDrawer onClose={() => setMgrAssignOpen(false)} />}
      <MaugoodTweaks tweaks={tweaks} setTweaks={setTweaks} />
    </div>
  );
}

function ManagerAssignLanding({ onOpen }) {
  const { EMPLOYEES, DEPARTMENTS } = window.APP_DATA;
  const managers = EMPLOYEES.filter(e => e.role === 'Manager' || e.role === 'Admin');
  // demo multi-dept assignments
  const demo = { 'OM0097': ['ops', 'eng'], 'OM0033': ['eng'], 'OM0088': ['fin'], 'OM0156': ['it'], 'OM0302': ['hr'], 'OM0003': ['it'] };
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Manager assignments</h1>
          <p className="page-sub">Assign a manager to <strong>multiple departments</strong> — useful when one lead oversees operations across teams</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={onOpen}><Icon name="edit" size={12} />Edit assignments</button>
        </div>
      </div>
      <div className="card">
        <table className="table">
          <thead><tr><th>Manager</th><th>Designation</th><th>Departments managed</th><th style={{width: 120}}>Employees</th><th style={{width: 80}}></th></tr></thead>
          <tbody>
            {managers.map(m => {
              const depts = demo[m.id] || [m.dept];
              const count = depts.reduce((s, id) => s + (DEPARTMENTS.find(d => d.id === id)?.count || 0), 0);
              return (
                <tr key={m.id}>
                  <td><UI.PersonCell person={m} /></td>
                  <td className="text-sm">{m.designation}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {depts.map(id => {
                        const d = DEPARTMENTS.find(x => x.id === id);
                        return <span key={id} className="chip chip-soft">{d?.name}</span>;
                      })}
                      {depts.length > 1 && <span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)', borderColor: 'var(--accent-border)' }}>Multi-dept</span>}
                    </div>
                  </td>
                  <td className="mono text-sm">{count}</td>
                  <td style={{textAlign: 'right'}}><button className="btn btn-sm btn-ghost" onClick={onOpen}><Icon name="edit" size={11} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AuditStub() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Audit log</h1>
          <p className="page-sub">Append-only trail of security- and data-relevant events</p>
        </div>
        <button className="btn"><Icon name="download" size={12} />Export</button>
      </div>
      <div className="card">
        <table className="table">
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>IP</th></tr></thead>
          <tbody>
            {[
              ['2026-04-23 08:32:11', 'Tariq Al-Shukaili', 'Camera added', 'CAM-09 · Reception West', '10.0.14.22'],
              ['2026-04-23 08:14:02', 'Aisha Al-Habsi', 'Approved request', 'REQ-1046 · OM0201', '10.0.14.88'],
              ['2026-04-23 08:00:01', 'system', 'Scheduled report delivered', 'HR Daily Attendance · 4 recipients', '—'],
              ['2026-04-23 07:58:33', 'Tariq Al-Shukaili', 'Logged in (Entra ID)', 'session abc123', '10.0.14.22'],
              ['2026-04-22 18:44:12', 'Hind Al-Lawati', 'Shift policy updated', 'Ramadan 2026 · window', '10.0.14.45'],
              ['2026-04-22 14:32:08', 'system', 'Import committed', 'omran-employees-apr.xlsx · 14 new, 7 updated', '—'],
            ].map((r, i) => (
              <tr key={i}>
                <td className="mono text-xs text-dim">{r[0]}</td>
                <td style={{ fontSize: 12.5, fontWeight: 500 }}>{r[1]}</td>
                <td>{r[2]}</td>
                <td className="text-sm">{r[3]}</td>
                <td className="mono text-xs text-dim">{r[4]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MaugoodTweaks({ tweaks, setTweaks }) {
  const T = window.TweaksPanel;
  const { TweakSection, TweakRadio, TweakToggle, TweakSelect } = window;
  return (
    <T title="Tweaks">
      <TweakSection title="Appearance">
        <TweakRadio label="Theme" value={tweaks.theme} onChange={v => setTweaks({ theme: v })} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        <TweakRadio label="Density" value={tweaks.density} onChange={v => setTweaks({ density: v })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500, marginBottom: 6 }}>Accent</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
            {Object.entries(ACCENTS).map(([k, a]) => (
              <button key={k} onClick={() => setTweaks({ accent: k })} title={a.name} style={{
                aspectRatio: 1, borderRadius: 6, background: a.c,
                border: tweaks.accent === k ? '2px solid var(--text)' : '1px solid var(--border)',
                cursor: 'pointer', outline: 'none'
              }} />
            ))}
          </div>
        </div>
      </TweakSection>

      <TweakSection title="Language">
        <TweakRadio label="Direction" value={tweaks.rtl ? 'rtl' : 'ltr'} onChange={v => setTweaks({ rtl: v === 'rtl' })}
          options={[{ value: 'ltr', label: 'English (LTR)' }, { value: 'rtl', label: 'العربية (RTL)' }]} />
      </TweakSection>

      <TweakSection title="Role">
        <TweakRadio label="View as" value={tweaks.role} onChange={v => setTweaks({ role: v })}
          options={[
            { value: 'Admin', label: 'Admin' },
            { value: 'HR', label: 'HR' },
            { value: 'Manager', label: 'Manager' },
            { value: 'Employee', label: 'Employee' },
          ]} />
      </TweakSection>

      <TweakSection title="Privacy">
        <TweakToggle label="Hide face thumbnails" value={tweaks.hideFaces} onChange={v => setTweaks({ hideFaces: v })} />
      </TweakSection>
    </T>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
