/* Maugood enhancements v3 — reports inline preview, employee CRUD, API docs, system monitoring */

/* ---------------- Reports inline preview ---------------- */

function ReportsPageV2({ onNewReport }) {
  const { REPORT_SCHEDULES, EMPLOYEES, DEPARTMENTS, genAttendance } = window.APP_DATA;
  const [selected, setSelected] = React.useState('daily');

  const reports = {
    daily: {
      name: 'Daily Attendance',
      sub: 'one row per person per day · worked hours vs policy',
      icon: 'calendar',
      cols: ['Employee ID', 'Name', 'Department', 'Date', 'Status', 'In', 'Out', 'Hours', 'OT'],
      rows: EMPLOYEES.slice(0, 8).map(e => {
        const rec = genAttendance(e.id.charCodeAt(3) * 13)[0];
        const d = DEPARTMENTS.find(x => x.id === e.dept);
        return [e.id, e.name, d?.name, '2026-04-23', rec.status, rec.inTime, rec.outTime, rec.hours > 0 ? rec.hours.toFixed(1) : '—', rec.overtime > 0 ? `+${rec.overtime}` : '—'];
      }),
    },
    event: {
      name: 'Event Log',
      sub: 'one row per detected face appearance',
      icon: 'activity',
      cols: ['Event ID', 'Timestamp', 'Camera', 'Employee', 'Confidence', 'Type'],
      rows: [
        ['EV-100234', '2026-04-23 07:42:18', 'CAM-02 · Front Gate', 'Fatima Al-Kindi', '91.2%', 'entry'],
        ['EV-100235', '2026-04-23 07:43:02', 'CAM-02 · Front Gate', 'Hassan Al-Balushi', '88.7%', 'entry'],
        ['EV-100236', '2026-04-23 07:44:55', 'CAM-01 · Entrance A', 'Aisha Al-Habsi', '94.0%', 'entry'],
        ['EV-100237', '2026-04-23 07:48:11', 'CAM-02 · Front Gate', 'Sultan Al-Busaidi', '76.4%', 'entry'],
        ['EV-100238', '2026-04-23 07:51:29', 'CAM-05 · Finance', 'Noor Al-Saidi', '89.9%', 'entry'],
        ['EV-100239', '2026-04-23 15:32:48', 'CAM-02 · Front Gate', 'Fatima Al-Kindi', '92.8%', 'exit'],
        ['EV-100240', '2026-04-23 15:34:01', 'CAM-02 · Front Gate', 'Hassan Al-Balushi', '90.1%', 'exit'],
        ['EV-100241', '2026-04-23 15:47:20', 'CAM-01 · Entrance A', 'Unidentified', '62.3%', 'entry'],
      ],
    },
    dept: {
      name: 'Department Summary',
      sub: 'aggregated present / late / absent per department per day',
      icon: 'building',
      cols: ['Department', 'Head', 'Headcount', 'Present', 'Late', 'Absent', 'On-leave', 'Avg hours'],
      rows: DEPARTMENTS.map(d => {
        const count = d.count;
        const p = Math.floor(count * 0.82);
        const l = Math.floor(count * 0.08);
        const a = Math.floor(count * 0.04);
        const lv = count - p - l - a;
        return [d.name, d.head, count, p, l, a, lv, (7.6 + Math.random() * 0.8).toFixed(1) + 'h'];
      }),
    },
  };

  const sel = reports[selected];

  const runDownload = () => {
    const { downloadXLSX, showToast } = window.Enhancements2;
    downloadXLSX(`${sel.name.toLowerCase().replace(/\s+/g,'-')}-2026-04-23.xls`, sel.rows, sel.cols);
    showToast(`Downloaded ${sel.rows.length}+ rows`);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">Preview data live, run on-demand, or schedule delivery to HR & managers</p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={runDownload}><Icon name="excel" size={12} />Download current</button>
          <button className="btn btn-primary" onClick={onNewReport}><Icon name="plus" size={12} />New schedule</button>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 14 }}>
        {Object.entries(reports).map(([k, r]) => (
          <button key={k} onClick={() => setSelected(k)} className={`report-tile ${selected === k ? 'active' : ''}`}>
            <div className="rt-icon"><Icon name={r.icon} size={16} /></div>
            <div className="rt-name">{r.name}</div>
            <div className="rt-sub">{r.sub}</div>
            <div className="rt-meta">{r.cols.length} columns · xlsx / pdf</div>
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="card-head">
          <div>
            <h3 className="card-title" style={{ marginBottom: 2 }}>Preview · {sel.name}</h3>
            <div className="text-xs text-dim">Sample showing first {sel.rows.length} rows · date 2026-04-23</div>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-sm"><Icon name="filter" size={11} />Filters</button>
            <button className="btn btn-sm"><Icon name="calendar" size={11} />2026-04-23</button>
            <button className="btn btn-sm btn-primary" onClick={runDownload}><Icon name="excel" size={11} />Run & download</button>
          </div>
        </div>
        <div className="preview-wrap">
          <table className="table table-compact preview-table">
            <thead>
              <tr>
                <th className="preview-rowhead">#</th>
                {sel.cols.map(c => <th key={c}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {sel.rows.map((r, i) => (
                <tr key={i}>
                  <td className="preview-rowhead mono text-xs text-dim">{i + 1}</td>
                  {r.map((v, j) => (
                    <td key={j} className={j === 0 ? 'mono text-xs' : 'text-sm'}>
                      {typeof v === 'string' && v.toLowerCase() === 'present' ? <Pill kind="success">Present</Pill> :
                       typeof v === 'string' && v.toLowerCase() === 'late' ? <Pill kind="warning">Late</Pill> :
                       typeof v === 'string' && v.toLowerCase() === 'absent' ? <Pill kind="danger">Absent</Pill> :
                       typeof v === 'string' && v.toLowerCase() === 'leave' ? <Pill kind="info">Leave</Pill> :
                       v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card-body preview-footer">
          <div className="text-xs text-dim"><strong>{sel.rows.length}</strong> preview rows · full dataset would be ~<strong>{selected === 'daily' ? '106' : selected === 'event' ? '1,240' : DEPARTMENTS.length}</strong> rows</div>
          <div className="flex gap-2">
            <button className="btn btn-sm btn-ghost">Expand preview</button>
            <button className="btn btn-sm btn-primary" onClick={runDownload}>Download XLSX</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Scheduled delivery</h3>
          <button className="btn btn-sm" onClick={onNewReport}><Icon name="plus" size={12} />Add schedule</button>
        </div>
        <table className="table">
          <thead><tr><th>Name</th><th>Report</th><th>Schedule</th><th>Recipients</th><th>Method</th><th>Last run</th><th>Status</th></tr></thead>
          <tbody>
            {REPORT_SCHEDULES.map(s => (
              <tr key={s.id}>
                <td style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}</td>
                <td className="text-sm">{s.type}</td>
                <td className="mono text-sm">{s.schedule}</td>
                <td className="text-sm">{s.recipients.join(', ')}</td>
                <td className="text-sm">{s.method}</td>
                <td className="mono text-xs text-dim">{s.lastRun}</td>
                <td><UI.StatusPill status={s.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------------- Employee CRUD ---------------- */

function EmployeesPageV2({ hideFaces, onOpenRecord }) {
  const { EMPLOYEES, DEPARTMENTS } = window.APP_DATA;
  const deptById = Object.fromEntries(DEPARTMENTS.map(d => [d.id, d]));
  const [open, setOpen] = React.useState(null); // { mode: 'add'|'edit'|'delete', emp }
  const [query, setQuery] = React.useState('');
  const [deptFilter, setDeptFilter] = React.useState('all');

  const filtered = EMPLOYEES.filter(e => {
    if (deptFilter !== 'all' && e.dept !== deptFilter) return false;
    if (query && !e.name.toLowerCase().includes(query.toLowerCase()) && !e.id.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Employees</h1>
          <p className="page-sub">{EMPLOYEES.length} people · <span className="mono">97%</span> fully enrolled with reference photos</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={12} />Export</button>
          <button className="btn"><Icon name="upload" size={12} />Import XLSX</button>
          <button className="btn btn-primary" onClick={() => setOpen({ mode: 'add', emp: null })}><Icon name="plus" size={12} />Add employee</button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-group" style={{ flex: 1, maxWidth: 320 }}>
          <Icon name="search" size={12} />
          <input className="input sm" placeholder="Search by name or employee ID…" value={query} onChange={e => setQuery(e.target.value)} style={{ border: 'none', flex: 1, background: 'transparent' }} />
        </div>
        <select className="input sm" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
          <option value="all">All departments</option>
          {DEPARTMENTS.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div className="filter-spacer" />
        <span className="text-xs text-dim mono">{filtered.length} / {EMPLOYEES.length}</span>
      </div>

      <div className="card">
        <table className="table">
          <thead><tr><th>Employee</th><th>ID</th><th>Department</th><th>Role</th><th>Policy</th><th>Manager</th><th style={{ width: 110, textAlign: 'right' }}>Actions</th></tr></thead>
          <tbody>
            {filtered.map(e => (
              <tr key={e.id}>
                <td onClick={() => onOpenRecord(e)} style={{ cursor: 'pointer' }}><UI.PersonCell person={e} hideFaces={hideFaces} subtitle={e.designation} /></td>
                <td className="mono text-sm">{e.id}</td>
                <td className="text-sm">{deptById[e.dept]?.name}</td>
                <td><Pill kind={e.role === 'Admin' ? 'accent' : e.role === 'HR' ? 'info' : e.role === 'Manager' ? 'warning' : 'neutral'}>{e.role}</Pill></td>
                <td className="text-sm"><span className="pill pill-neutral">{e.policy}</span></td>
                <td className="text-sm">{e.mgr ? EMPLOYEES.find(x => x.id === e.mgr)?.name.split(' ')[0] : <span className="text-dim">—</span>}</td>
                <td style={{ textAlign: 'right' }}>
                  <div className="row-actions">
                    <button className="btn btn-sm btn-ghost" title="View" onClick={() => onOpenRecord(e)}><Icon name="eye" size={11} /></button>
                    <button className="btn btn-sm btn-ghost" title="Edit" onClick={() => setOpen({ mode: 'edit', emp: e })}><Icon name="edit" size={11} /></button>
                    <button className="btn btn-sm btn-ghost danger" title="Delete" onClick={() => setOpen({ mode: 'delete', emp: e })}><Icon name="trash" size={11} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && open.mode !== 'delete' && <EmployeeFormDrawer mode={open.mode} emp={open.emp} onClose={() => setOpen(null)} />}
      {open && open.mode === 'delete' && <EmployeeDeleteConfirm emp={open.emp} onClose={() => setOpen(null)} hideFaces={hideFaces} />}
    </>
  );
}

function EmployeeFormDrawer({ mode, emp, onClose }) {
  const { DEPARTMENTS, EMPLOYEES } = window.APP_DATA;
  const { showToast } = window.Enhancements2;
  const isEdit = mode === 'edit';
  const [form, setForm] = React.useState({
    id: emp?.id || `OM${String(Math.floor(Math.random() * 900 + 100)).padStart(4, '0')}`,
    name: emp?.name || '',
    email: emp?.email || '',
    phone: emp?.phone || '+968 9',
    dept: emp?.dept || 'ops',
    role: emp?.role || 'Employee',
    designation: emp?.designation || '',
    mgr: emp?.mgr || '',
    policy: emp?.policy || 'Fixed 07:30–15:30',
    joinDate: emp?.joinDate || '2026-04-23',
    active: emp?.active !== false,
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const managers = EMPLOYEES.filter(e => e.role === 'Manager' || e.role === 'Admin' || e.role === 'HR');

  const handleSave = () => {
    showToast(isEdit ? `Updated ${form.name}` : `Created ${form.name} · ${form.id}`);
    onClose();
  };

  return (
    <FormDrawer
      title={isEdit ? `Edit ${emp.name}` : 'Add new employee'}
      sub={isEdit ? `Employee ${emp.id} · last updated 2 days ago` : 'Personal details, role, shift policy, and reference photos'}
      onClose={onClose}
      wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        {isEdit && <div style={{ flex: 1 }}><span className="text-xs text-dim mono">Changes audited & reversible for 24h</span></div>}
        <button className="btn btn-primary" onClick={handleSave}><Icon name="check" size={12} />{isEdit ? 'Save changes' : 'Create employee'}</button>
      </>}>
      <div className="form-section">
        <div className="fs-title">Identity</div>
        <div className="grid" style={{ gridTemplateColumns: '140px 1fr 1fr', gap: 10 }}>
          <div className="field">
            <label className="field-label">Employee ID</label>
            <input className="input mono" value={form.id} onChange={e => set('id', e.target.value)} disabled={isEdit} />
            {isEdit && <span className="field-help">Cannot be changed</span>}
          </div>
          <div className="field">
            <label className="field-label">Full name <span className="req">*</span></label>
            <input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Fatima Al-Kindi" />
          </div>
          <div className="field">
            <label className="field-label">Designation</label>
            <input className="input" value={form.designation} onChange={e => set('designation', e.target.value)} placeholder="Operations Analyst" />
          </div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <div className="field">
            <label className="field-label">Email <span className="req">*</span></label>
            <input className="input" value={form.email} onChange={e => set('email', e.target.value)} placeholder="name@omran.om" />
          </div>
          <div className="field">
            <label className="field-label">Phone</label>
            <input className="input mono" value={form.phone} onChange={e => set('phone', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="fs-title">Assignment</div>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <div className="field">
            <label className="field-label">Department</label>
            <select className="input" value={form.dept} onChange={e => set('dept', e.target.value)}>
              {DEPARTMENTS.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label">Role</label>
            <select className="input" value={form.role} onChange={e => set('role', e.target.value)}>
              {['Employee', 'Manager', 'HR', 'Admin'].map(r => <option key={r}>{r}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field-label">Reports to</label>
            <select className="input" value={form.mgr} onChange={e => set('mgr', e.target.value)}>
              <option value="">— (no manager)</option>
              {managers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
        </div>
        <div className="grid" style={{ gridTemplateColumns: '1fr 180px', gap: 10, marginTop: 10 }}>
          <div className="field">
            <label className="field-label">Shift policy</label>
            <select className="input" value={form.policy} onChange={e => set('policy', e.target.value)}>
              <option>Fixed 07:30–15:30</option>
              <option>Fixed 08:00–16:00</option>
              <option>Flex 07:30–16:30</option>
              <option>Ramadan 2026</option>
              <option>Night shift</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label">Join date</label>
            <input type="date" className="input mono" value={form.joinDate} onChange={e => set('joinDate', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="form-section">
        <div className="fs-title">Reference photos</div>
        <div className="text-xs text-dim" style={{ marginBottom: 8 }}>3–5 photos from different angles improve match accuracy. Used as the reference gallery for face comparison.</div>
        <div className="photo-grid">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="photo-slot">
              {isEdit && i <= 3 ? (
                <div className="photo-filled" style={{ background: emp?.avatar || 'var(--accent-soft)' }}>
                  <span>{emp?.initials}</span>
                  <button className="photo-remove"><Icon name="x" size={10} /></button>
                </div>
              ) : (
                <div className="photo-empty">
                  <Icon name="plus" size={16} />
                  <span>Add</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="form-section">
        <div className="fs-title">Status</div>
        <label className="toggle-row">
          <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Active</div>
            <div className="text-xs text-dim">Inactive employees still appear in historical reports but are not tracked for new attendance</div>
          </div>
        </label>
      </div>
    </FormDrawer>
  );
}

function EmployeeDeleteConfirm({ emp, onClose, hideFaces }) {
  const { showToast } = window.Enhancements2;
  const [confirm, setConfirm] = React.useState('');
  const canDelete = confirm === emp.id;

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="confirm-modal">
        <div className="cm-head">
          <div className="cm-icon"><Icon name="alert" size={20} /></div>
          <h3>Delete employee?</h3>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="cm-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 8, marginBottom: 14 }}>
            <UI.FaceThumb person={emp} size="lg" hideFaces={hideFaces} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{emp.name}</div>
              <div className="mono text-xs text-dim">{emp.id} · {emp.designation}</div>
            </div>
          </div>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            This will <strong>deactivate</strong> the employee and remove them from the reference gallery.
            Historical attendance records, camera events, and audit logs will be preserved.
          </p>
          <div className="warn-box">
            <Icon name="alert" size={13} />
            <div>
              <strong>This is reversible for 30 days.</strong> After that, personal data is permanently purged per PDPL.
            </div>
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label className="field-label">Type <span className="mono" style={{ color: 'var(--danger-text)' }}>{emp.id}</span> to confirm</label>
            <input className="input mono" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={emp.id} />
          </div>
        </div>
        <div className="cm-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" disabled={!canDelete} onClick={() => { showToast(`Deleted ${emp.name}`); onClose(); }}>
            <Icon name="trash" size={11} />Delete employee
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------------- API Reference / Docs ---------------- */

function ApiDocsPage() {
  const [section, setSection] = React.useState('overview');
  const [endpoint, setEndpoint] = React.useState('attendance-get');

  const sections = [
    { id: 'overview', label: 'Overview', icon: 'info' },
    { id: 'auth', label: 'Authentication', icon: 'shield' },
    { id: 'rate', label: 'Rate limits', icon: 'clock' },
    { id: 'webhook', label: 'Webhooks', icon: 'link' },
  ];

  const endpoints = [
    { group: 'Attendance', items: [
      { id: 'attendance-get', method: 'GET', path: '/v1/attendance/{employee_id}', desc: 'Fetch a single employee\'s records' },
      { id: 'attendance-list', method: 'GET', path: '/v1/attendance', desc: 'List across a date range, with filters' },
      { id: 'attendance-export', method: 'POST', path: '/v1/attendance/export', desc: 'Generate XLSX export job' },
    ]},
    { group: 'Employees', items: [
      { id: 'emp-list', method: 'GET', path: '/v1/employees', desc: 'List all employees' },
      { id: 'emp-create', method: 'POST', path: '/v1/employees', desc: 'Create a new employee' },
      { id: 'emp-update', method: 'PATCH', path: '/v1/employees/{id}', desc: 'Update employee details' },
      { id: 'emp-delete', method: 'DELETE', path: '/v1/employees/{id}', desc: 'Deactivate employee' },
    ]},
    { group: 'Cameras', items: [
      { id: 'cam-list', method: 'GET', path: '/v1/cameras', desc: 'List all cameras and their status' },
      { id: 'cam-events', method: 'GET', path: '/v1/cameras/{id}/events', desc: 'Raw detection events' },
    ]},
    { group: 'Reports', items: [
      { id: 'rpt-run', method: 'POST', path: '/v1/reports/run', desc: 'Run a report on-demand' },
      { id: 'rpt-schedule', method: 'POST', path: '/v1/reports/schedule', desc: 'Create scheduled delivery' },
    ]},
  ];

  const all = endpoints.flatMap(g => g.items);
  const current = all.find(e => e.id === endpoint);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">API reference</h1>
          <p className="page-sub">REST API for integrating Maugood with payroll, HRIS, and other systems · v1 · base URL <code className="mono">https://api.maugood.om</code></p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={12} />OpenAPI 3.0</button>
          <button className="btn btn-primary"><Icon name="plus" size={12} />New API key</button>
        </div>
      </div>

      <div className="docs-layout">
        <aside className="docs-nav">
          <div className="docs-nav-group">
            <div className="docs-nav-title">Guides</div>
            {sections.map(s => (
              <button key={s.id} className={`docs-nav-item ${section === s.id && !endpoint ? 'active' : ''}`} onClick={() => { setSection(s.id); setEndpoint(null); }}>
                <Icon name={s.icon} size={12} />{s.label}
              </button>
            ))}
          </div>
          {endpoints.map(g => (
            <div key={g.group} className="docs-nav-group">
              <div className="docs-nav-title">{g.group}</div>
              {g.items.map(e => (
                <button key={e.id} className={`docs-nav-item endpoint ${endpoint === e.id ? 'active' : ''}`} onClick={() => setEndpoint(e.id)}>
                  <span className={`method-tag method-${e.method.toLowerCase()}`}>{e.method}</span>
                  <span className="mono">{e.path.split('/').slice(-1)[0].replace(/[{}]/g, '')}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>
        <div className="docs-main">
          {endpoint && current ? <EndpointDoc ep={current} /> : <OverviewDoc section={section} />}
        </div>
      </div>
    </>
  );
}

function OverviewDoc({ section }) {
  if (section === 'overview') {
    return (
      <div className="docs-content">
        <h2 className="docs-h1">Overview</h2>
        <p className="docs-p">The Maugood API is organized around REST. It accepts JSON-encoded request bodies, returns JSON-encoded responses, and uses standard HTTP response codes and verbs.</p>
        <div className="docs-callout">
          <div className="dc-label">Base URL</div>
          <code className="mono docs-code-inline">https://api.maugood.om/v1</code>
        </div>
        <h3 className="docs-h2">Quick start</h3>
        <CodeBlock lang="bash" code={`curl https://api.maugood.om/v1/attendance \\
  -H "Authorization: Bearer HDR_sk_live_a3f9...de21" \\
  -H "Content-Type: application/json" \\
  -G --data-urlencode "from=2026-04-01" \\
     --data-urlencode "to=2026-04-23"`} />
        <h3 className="docs-h2">Response format</h3>
        <CodeBlock lang="json" code={`{
  "ok": true,
  "data": [ /* ... */ ],
  "pagination": { "next": "cur_abc123", "total": 1284 },
  "request_id": "req_01HXXXZZ..."
}`} />
      </div>
    );
  }
  if (section === 'auth') {
    return (
      <div className="docs-content">
        <h2 className="docs-h1">Authentication</h2>
        <p className="docs-p">Maugood uses API keys tied to a workspace and a role. Send your key in the <code className="docs-code-inline">Authorization</code> header as a Bearer token.</p>
        <CodeBlock lang="http" code={`GET /v1/attendance HTTP/1.1
Host: api.maugood.om
Authorization: Bearer HDR_sk_live_a3f9...de21`} />
        <h3 className="docs-h2">Key types</h3>
        <table className="table table-compact" style={{ marginTop: 12 }}>
          <thead><tr><th>Prefix</th><th>Use</th><th>Rotatable</th></tr></thead>
          <tbody>
            <tr><td className="mono text-sm">HDR_sk_live_</td><td>Live server-side</td><td>Yes</td></tr>
            <tr><td className="mono text-sm">HDR_sk_test_</td><td>Sandbox (non-production)</td><td>Yes</td></tr>
            <tr><td className="mono text-sm">HDR_pk_</td><td>Read-only dashboards</td><td>Yes</td></tr>
          </tbody>
        </table>
      </div>
    );
  }
  if (section === 'rate') {
    return (
      <div className="docs-content">
        <h2 className="docs-h1">Rate limits</h2>
        <p className="docs-p">Each workspace is limited to <strong>600 requests per minute</strong> and <strong>50,000 per day</strong>. Exceeded requests return <code className="docs-code-inline">429 Too Many Requests</code>.</p>
        <h3 className="docs-h2">Headers returned</h3>
        <CodeBlock lang="http" code={`X-RateLimit-Limit: 600
X-RateLimit-Remaining: 588
X-RateLimit-Reset: 1745367240`} />
      </div>
    );
  }
  return (
    <div className="docs-content">
      <h2 className="docs-h1">Webhooks</h2>
      <p className="docs-p">Subscribe to events and receive POST callbacks. Each delivery is signed with <code className="docs-code-inline">X-Maugood-Signature</code> using HMAC-SHA256.</p>
      <h3 className="docs-h2">Event types</h3>
      <ul className="docs-list">
        <li><code className="docs-code-inline">attendance.recorded</code> — a new attendance entry was committed</li>
        <li><code className="docs-code-inline">attendance.flagged</code> — a record was flagged (late, early-leave, no-match)</li>
        <li><code className="docs-code-inline">employee.created</code> / <code className="docs-code-inline">employee.updated</code> / <code className="docs-code-inline">employee.deactivated</code></li>
        <li><code className="docs-code-inline">camera.offline</code> — a camera stopped streaming</li>
        <li><code className="docs-code-inline">report.ready</code> — a scheduled report finished generating</li>
      </ul>
    </div>
  );
}

function EndpointDoc({ ep }) {
  const body = {
    'attendance-get': {
      params: [
        { n: 'employee_id', t: 'string', req: true, d: 'The employee ID (e.g. OM0045)' },
        { n: 'from', t: 'date', req: false, d: 'Start date, inclusive · default: 30d ago' },
        { n: 'to', t: 'date', req: false, d: 'End date, inclusive · default: today' },
      ],
      sample: `curl https://api.maugood.om/v1/attendance/OM0045 \\
  -H "Authorization: Bearer HDR_sk_live_..." \\
  -G --data-urlencode "from=2026-04-01"`,
      response: `{
  "ok": true,
  "data": {
    "employee_id": "OM0045",
    "name": "Fatima Al-Kindi",
    "records": [
      { "date": "2026-04-23", "status": "present",
        "in": "07:42:18", "out": "15:32:48",
        "hours": 7.84, "overtime": 0,
        "camera_events": 2 }
    ]
  }
}`,
    },
  };
  const b = body[ep.id] || body['attendance-get'];
  return (
    <div className="docs-content">
      <div className="endpoint-head">
        <span className={`method-tag method-${ep.method.toLowerCase()} big`}>{ep.method}</span>
        <code className="endpoint-path">{ep.path}</code>
      </div>
      <p className="docs-p">{ep.desc}.</p>
      <h3 className="docs-h2">Parameters</h3>
      <table className="table table-compact">
        <thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>
          {b.params.map(p => (
            <tr key={p.n}>
              <td className="mono text-sm">{p.n}</td>
              <td className="mono text-xs text-dim">{p.t}</td>
              <td>{p.req ? <Pill kind="warning">required</Pill> : <span className="text-xs text-dim">optional</span>}</td>
              <td className="text-sm">{p.d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="docs-h2">Example request</h3>
      <CodeBlock lang="bash" code={b.sample} />
      <h3 className="docs-h2">Example response</h3>
      <CodeBlock lang="json" code={b.response} />
    </div>
  );
}

function CodeBlock({ lang, code }) {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="code-block">
      <div className="cb-head">
        <span className="cb-lang">{lang}</span>
        <button className="cb-copy" onClick={copy}>
          <Icon name={copied ? 'check' : 'clipboard'} size={11} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="cb-pre">{code}</pre>
    </div>
  );
}

/* ---------------- System monitoring ---------------- */

function SystemPage() {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1800);
    return () => clearInterval(t);
  }, []);

  // Live-ish series
  const cpu = React.useMemo(() => Array.from({ length: 40 }, (_, i) =>
    30 + Math.sin((i + tick) * 0.3) * 8 + Math.random() * 12
  ), [tick]);
  const ram = React.useMemo(() => Array.from({ length: 40 }, (_, i) =>
    58 + Math.cos((i + tick) * 0.2) * 4 + Math.random() * 4
  ), [tick]);

  const stor = [
    { name: 'Face captures (raw)', bytes: 2_140_000_000_000, total: 4_000_000_000_000, color: 'oklch(0.66 0.15 195)' },
    { name: 'Reference gallery', bytes: 48_000_000_000, total: 200_000_000_000, color: 'oklch(0.66 0.15 155)' },
    { name: 'Attendance ledger (DB)', bytes: 312_000_000_000, total: 1_000_000_000_000, color: 'oklch(0.66 0.15 75)' },
    { name: 'Exports & reports', bytes: 88_000_000_000, total: 500_000_000_000, color: 'oklch(0.66 0.15 280)' },
    { name: 'Logs & audit trail', bytes: 14_000_000_000, total: 100_000_000_000, color: 'oklch(0.66 0.15 20)' },
  ];
  const totalUsed = stor.reduce((s, x) => s + x.bytes, 0);
  const totalCap = stor.reduce((s, x) => s + x.total, 0);

  const services = [
    { name: 'Face detection workers', count: '4 / 4', status: 'online', load: 42 },
    { name: 'Embedding service', count: '2 / 2', status: 'online', load: 61 },
    { name: 'Matching engine', count: '3 / 3', status: 'online', load: 38 },
    { name: 'Attendance generator', count: '1 / 1', status: 'online', load: 18 },
    { name: 'Report scheduler', count: '1 / 1', status: 'online', load: 4 },
    { name: 'Camera RTSP ingest', count: '8 / 8', status: 'warning', load: 88 },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">System & infrastructure</h1>
          <p className="page-sub">Live metrics · storage, compute, and service health · auto-refreshing every 2s</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={12} />Metrics CSV</button>
          <button className="btn"><Icon name="settings" size={12} />Alerts</button>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <MetricCard label="CPU" value={`${Math.round(cpu[cpu.length - 1])}%`} sub="avg last 60s · 32 cores" series={cpu} tone={cpu[cpu.length-1] > 75 ? 'danger' : 'accent'} />
        <MetricCard label="Memory" value={`${Math.round(ram[ram.length - 1])}%`} sub={`${(ram[ram.length-1] * 1.28).toFixed(1)} / 128 GB`} series={ram} tone="success" />
        <MetricCard label="Storage" value={`${Math.round((totalUsed / totalCap) * 100)}%`} sub={`${(totalUsed / 1e12).toFixed(2)} TB of ${(totalCap / 1e12).toFixed(1)} TB`} tone="warning" noChart />
        <MetricCard label="Network" value="182 Mbps" sub="CCTV ingest · 8 streams" tone="accent" noChart />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.2fr 1fr', gap: 14, marginBottom: 14 }}>
        <div className="card">
          <div className="card-head">
            <div><h3 className="card-title">Storage breakdown</h3><div className="text-xs text-dim">{(totalUsed / 1e12).toFixed(2)} TB used of {(totalCap / 1e12).toFixed(1)} TB provisioned</div></div>
            <button className="btn btn-sm">Purge policy</button>
          </div>
          <div className="card-body">
            <div className="stack-bar">
              {stor.map(s => (
                <div key={s.name} className="sb-seg" style={{ flex: s.bytes, background: s.color }} title={`${s.name} · ${fmtBytes(s.bytes)}`} />
              ))}
              <div className="sb-seg unused" style={{ flex: totalCap - totalUsed }} />
            </div>
            <table className="table table-compact" style={{ marginTop: 12 }}>
              <thead><tr><th></th><th>Category</th><th>Used</th><th>Of</th><th style={{ width: 160 }}>Utilization</th></tr></thead>
              <tbody>
                {stor.map(s => {
                  const pct = (s.bytes / s.total) * 100;
                  return (
                    <tr key={s.name}>
                      <td style={{ width: 10 }}><span className="swatch" style={{ background: s.color }} /></td>
                      <td className="text-sm" style={{ fontWeight: 500 }}>{s.name}</td>
                      <td className="mono text-sm">{fmtBytes(s.bytes)}</td>
                      <td className="mono text-xs text-dim">{fmtBytes(s.total)}</td>
                      <td>
                        <div className="util-bar"><div style={{ width: `${pct}%`, background: s.color }} /></div>
                        <span className="mono text-xs text-dim" style={{ marginLeft: 6 }}>{pct.toFixed(0)}%</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3 className="card-title">Services</h3><Pill kind="success" dot>5 of 6 healthy</Pill></div>
          <table className="table table-compact">
            <thead><tr><th>Service</th><th>Instances</th><th>Load</th><th>Status</th></tr></thead>
            <tbody>
              {services.map(s => (
                <tr key={s.name}>
                  <td className="text-sm" style={{ fontWeight: 500 }}>{s.name}</td>
                  <td className="mono text-xs text-dim">{s.count}</td>
                  <td>
                    <div className="util-bar sm"><div style={{ width: `${s.load}%`, background: s.load > 80 ? 'var(--danger)' : s.load > 60 ? 'var(--warning)' : 'var(--success)' }} /></div>
                    <span className="mono text-xs text-dim">{s.load}%</span>
                  </td>
                  <td><Pill kind={s.status === 'warning' ? 'warning' : 'success'} dot>{s.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
        <div className="card" style={{ padding: 16 }}>
          <div className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Uptime · 30 days</div>
          <div style={{ fontSize: 34, fontWeight: 600, marginTop: 6, fontFamily: "'Instrument Serif', serif", fontStyle: 'italic' }}>99.94<span style={{ fontSize: 20, color: 'var(--text-tertiary)' }}>%</span></div>
          <div className="text-xs text-dim">Target 99.9% · 1 incident last month (CAM-08 timeout)</div>
          <div className="uptime-bar" style={{ marginTop: 12 }}>
            {Array.from({ length: 30 }).map((_, i) => (
              <div key={i} className={`ub-day ${i === 14 ? 'warning' : ''}`} title={`Day ${i + 1}`} />
            ))}
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Events processed · today</div>
          <div style={{ fontSize: 34, fontWeight: 600, marginTop: 6, fontFamily: "'Instrument Serif', serif", fontStyle: 'italic' }}>12,448</div>
          <div className="text-xs text-dim">peak 4.2/s at 07:48 · avg 0.8/s</div>
          <UI.Sparkline data={Array.from({ length: 24 }, (_, i) => 40 + Math.sin(i * 0.5) * 30 + Math.random() * 20)} color="var(--accent)" height={30} />
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Match accuracy</div>
          <div style={{ fontSize: 34, fontWeight: 600, marginTop: 6, fontFamily: "'Instrument Serif', serif", fontStyle: 'italic' }}>97.8<span style={{ fontSize: 20, color: 'var(--text-tertiary)' }}>%</span></div>
          <div className="text-xs text-dim">2.2% flagged for HR review · threshold 0.78</div>
          <div className="mt-3" style={{ marginTop: 10, display: 'flex', gap: 4 }}>
            {[97.8, 98.1, 97.5, 98.0, 97.9, 97.8].map((v, i) => (
              <div key={i} style={{ flex: 1, height: 24, background: 'var(--accent-soft)', borderRadius: 3, position: 'relative' }}>
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: `${(v - 95) / 5 * 100}%`, background: 'var(--accent)', borderRadius: 3 }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function MetricCard({ label, value, sub, series, tone = 'accent', noChart }) {
  const toneMap = {
    accent: 'var(--accent)',
    success: 'var(--success)',
    warning: 'var(--warning)',
    danger: 'var(--danger)',
  };
  const color = toneMap[tone] || toneMap.accent;
  return (
    <div className="card metric-card" style={{ padding: 16 }}>
      <div className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 600, margin: '6px 0 2px', fontFamily: "'Instrument Serif', serif", fontStyle: 'italic', color }}>{value}</div>
      <div className="text-xs text-dim">{sub}</div>
      {!noChart && series && <UI.Sparkline data={series} color={color} height={36} />}
    </div>
  );
}

function fmtBytes(b) {
  if (b > 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b > 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  return b + ' B';
}

window.Enhancements3 = { ReportsPageV2, EmployeesPageV2, ApiDocsPage, SystemPage };
