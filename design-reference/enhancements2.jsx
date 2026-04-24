/* Hadir enhancements v2 — leave policies, XLSX generator, camera logs,
   multi-dept managers, capture→compare explainer */

/* ---------- tiny CSV→XLSX trigger (mocked: generates a .xls-ish HTML blob) ---------- */

function downloadXLSX(filename, rows, header) {
  // Build a tab-separated .xls file (Excel opens it)
  const esc = v => String(v ?? '').replace(/\t|\n/g, ' ');
  const lines = [header.map(esc).join('\t'), ...rows.map(r => r.map(esc).join('\t'))];
  const blob = new Blob([lines.join('\n')], { type: 'application/vnd.ms-excel' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 13l4 4L19 7"/></svg>${msg}`;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('in'), 10);
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, 2600);
}

/* ---------- Leave Policy page: weekend config + holidays editor ---------- */

function LeavePolicyPage() {
  const { HOLIDAYS_2026 } = window.APP_DATA;
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const [weekStart, setWeekStart] = React.useState(0); // Sun
  const [weekend, setWeekend] = React.useState([5, 6]); // Fri, Sat
  const [holidays, setHolidays] = React.useState(HOLIDAYS_2026);
  const [leaveTypes, setLeaveTypes] = React.useState([
    { id: 'annual', name: 'Annual leave', days: 30, paid: true, carryOver: 15 },
    { id: 'sick', name: 'Sick leave', days: 10, paid: true, carryOver: 0 },
    { id: 'maternity', name: 'Maternity', days: 50, paid: true, carryOver: 0 },
    { id: 'paternity', name: 'Paternity', days: 3, paid: true, carryOver: 0 },
    { id: 'emergency', name: 'Emergency', days: 6, paid: true, carryOver: 0 },
    { id: 'unpaid', name: 'Unpaid leave', days: 0, paid: false, carryOver: 0 },
  ]);

  const toggleWeekend = (i) => setWeekend(w => w.includes(i) ? w.filter(x => x !== i) : [...w, i]);
  const addHoliday = () => setHolidays(h => [...h, { date: '2026-12-31', name: 'New holiday' }]);
  const updHoliday = (i, k, v) => setHolidays(h => h.map((x,idx) => idx === i ? {...x, [k]: v} : x));
  const delHoliday = (i) => setHolidays(h => h.filter((_,idx) => idx !== i));

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Leave policy & calendar</h1>
          <p className="page-sub">Work week, weekend days, public holidays and leave type allowances</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={12} />Export calendar</button>
          <button className="btn btn-primary"><Icon name="check" size={12} />Save policy</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div className="card">
          <div className="card-head"><h3 className="card-title">Work week</h3></div>
          <div className="card-body">
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label">Week starts on</label>
              <div className="seg">
                {DAYS.map((d, i) => (
                  <button key={d} className={`seg-btn ${weekStart === i ? 'active' : ''}`} onClick={() => setWeekStart(i)}>{d.slice(0,3)}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="field-label">Weekend days</label>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {DAYS.map((d, i) => (
                  <button key={d} onClick={() => toggleWeekend(i)} className={`chip-toggle ${weekend.includes(i) ? 'on' : ''}`} style={{ cursor: 'pointer' }}>{d}</button>
                ))}
              </div>
              <span className="field-help">Oman default: Friday & Saturday. Gulf variant: Saturday only. No attendance is expected on weekend days.</span>
            </div>
            <div style={{ marginTop: 18, padding: 12, background: 'var(--accent-soft)', border: '1px solid var(--accent-border)', borderRadius: 8 }}>
              <div className="text-xs" style={{ fontWeight: 600, color: 'var(--accent-text)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Preview</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
                Your week: <strong>{DAYS[weekStart]}</strong> → <strong>{DAYS[(weekStart + 6) % 7]}</strong><br/>
                Working days per week: <strong>{7 - weekend.length}</strong> ({DAYS.filter((_,i)=>!weekend.includes(i)).map(d=>d.slice(0,3)).join(', ')})
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Leave types</h3>
            <button className="btn btn-sm"><Icon name="plus" size={11} />Add</button>
          </div>
          <table className="table table-compact">
            <thead><tr><th>Name</th><th>Days / yr</th><th>Paid</th><th>Carry over</th><th></th></tr></thead>
            <tbody>
              {leaveTypes.map((l,i) => (
                <tr key={l.id}>
                  <td style={{ fontSize: 12.5, fontWeight: 500 }}>{l.name}</td>
                  <td className="mono text-sm">{l.days}</td>
                  <td>{l.paid ? <Pill kind="success">Paid</Pill> : <Pill kind="neutral">Unpaid</Pill>}</td>
                  <td className="mono text-sm">{l.carryOver > 0 ? `${l.carryOver} days` : '—'}</td>
                  <td style={{ textAlign: 'right' }}><button className="btn btn-sm btn-ghost"><Icon name="edit" size={11} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <h3 className="card-title">Public holidays {new Date().getFullYear()}</h3>
          <div className="flex gap-2">
            <button className="btn btn-sm"><Icon name="upload" size={11} />Import ICS</button>
            <button className="btn btn-sm btn-primary" onClick={addHoliday}><Icon name="plus" size={11} />Add holiday</button>
          </div>
        </div>
        <table className="table table-compact">
          <thead><tr><th style={{ width: 160 }}>Date</th><th style={{ width: 120 }}>Day</th><th>Name</th><th style={{ width: 140 }}>Type</th><th style={{ width: 60 }}></th></tr></thead>
          <tbody>
            {holidays.map((h, i) => {
              const dt = new Date(h.date);
              return (
                <tr key={i}>
                  <td><input className="input mono sm" type="date" value={h.date} onChange={e => updHoliday(i, 'date', e.target.value)} /></td>
                  <td className="text-sm text-dim">{DAYS[dt.getDay()]}</td>
                  <td><input className="input sm" value={h.name} onChange={e => updHoliday(i, 'name', e.target.value)} /></td>
                  <td>
                    <select className="input sm"><option>Public</option><option>Islamic · lunar</option><option>Company-specific</option></select>
                  </td>
                  <td style={{ textAlign: 'right' }}><button className="btn btn-sm btn-ghost" onClick={() => delHoliday(i)}><Icon name="trash" size={11} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- Daily Attendance page: generate & download ---------- */

function DailyAttendancePage({ hideFaces }) {
  const { EMPLOYEES, DEPARTMENTS, genAttendance } = window.APP_DATA;
  const [date, setDate] = React.useState('2026-04-23');
  const [scope, setScope] = React.useState('company'); // company | dept | team | person
  const [deptId, setDeptId] = React.useState('ops');
  const [mgrId, setMgrId] = React.useState('OM0097');
  const [personQ, setPersonQ] = React.useState('');
  const [personId, setPersonId] = React.useState('OM0045');

  const scoped = React.useMemo(() => {
    if (scope === 'company') return EMPLOYEES;
    if (scope === 'dept') return EMPLOYEES.filter(e => e.dept === deptId || (e.depts && e.depts.includes(deptId)));
    if (scope === 'team') return EMPLOYEES.filter(e => e.mgr === mgrId);
    if (scope === 'person') return EMPLOYEES.filter(e => e.id === personId);
    return EMPLOYEES;
  }, [scope, deptId, mgrId, personId]);

  const rows = React.useMemo(() => scoped.map(e => {
    const att = genAttendance(e.id.charCodeAt(3) * 13);
    const rec = att.find(a => a.date.toISOString().slice(0,10) === date) || att[0];
    const dept = DEPARTMENTS.find(d => d.id === e.dept);
    return {
      emp: e, dept, rec,
      inTime: rec.inTime, outTime: rec.outTime,
      hours: rec.hours, ot: rec.overtime, status: rec.status,
    };
  }), [scoped, date]);

  const summary = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1; return acc;
  }, {});

  const managers = EMPLOYEES.filter(e => e.role === 'Manager');

  const handleDownload = () => {
    downloadXLSX(
      `attendance-${date}-${scope}.xls`,
      rows.map(r => [r.emp.id, r.emp.name, r.dept?.name, r.emp.designation, date, r.status, r.inTime, r.outTime, r.hours > 0 ? r.hours.toFixed(1) : '', r.ot > 0 ? r.ot.toFixed(1) : '', r.rec.flags.join('; ')]),
      ['Employee ID', 'Name', 'Department', 'Designation', 'Date', 'Status', 'In time', 'Out time', 'Hours', 'Overtime', 'Flags']
    );
    showToast(`Downloaded ${rows.length} rows · attendance-${date}-${scope}.xls`);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Daily attendance</h1>
          <p className="page-sub">Generate today's attendance from camera events · download XLSX · filter by person, team or department</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="refresh" size={12} />Regenerate from events</button>
          <button className="btn btn-primary" onClick={handleDownload}><Icon name="excel" size={12} />Download XLSX</button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <span className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Date</span>
          <input className="input mono sm" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="seg">
          <button className={`seg-btn ${scope === 'company' ? 'active' : ''}`} onClick={() => setScope('company')}><Icon name="building" size={11} />Company</button>
          <button className={`seg-btn ${scope === 'dept' ? 'active' : ''}`} onClick={() => setScope('dept')}><Icon name="building" size={11} />Department</button>
          <button className={`seg-btn ${scope === 'team' ? 'active' : ''}`} onClick={() => setScope('team')}><Icon name="users" size={11} />Team</button>
          <button className={`seg-btn ${scope === 'person' ? 'active' : ''}`} onClick={() => setScope('person')}><Icon name="user" size={11} />Individual</button>
        </div>
        {scope === 'dept' && (
          <select className="input sm" value={deptId} onChange={e => setDeptId(e.target.value)}>
            {DEPARTMENTS.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        {scope === 'team' && (
          <select className="input sm" value={mgrId} onChange={e => setMgrId(e.target.value)}>
            {managers.map(m => <option key={m.id} value={m.id}>{m.name}'s team</option>)}
          </select>
        )}
        {scope === 'person' && (
          <div className="person-search" style={{ maxWidth: 280 }}>
            <Icon name="search" size={12} />
            <input placeholder="ID or name" value={personQ} onChange={e => setPersonQ(e.target.value)} />
            {personQ && (
              <div className="person-search-results">
                {EMPLOYEES.filter(e => e.name.toLowerCase().includes(personQ.toLowerCase()) || e.id.toLowerCase().includes(personQ.toLowerCase())).slice(0,6).map(e => (
                  <div key={e.id} className="person-search-row" onClick={() => { setPersonId(e.id); setPersonQ(''); }}>
                    <UI.FaceThumb person={e} hideFaces={hideFaces} />
                    <div><div style={{ fontSize: 12.5, fontWeight: 500 }}>{e.name}</div><div className="mono text-xs text-dim">{e.id}</div></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="filter-spacer" />
        <span className="text-xs text-dim mono">{rows.length} employees in scope</span>
      </div>

      <div className="grid grid-5" style={{ marginBottom: 14 }}>
        <StatBlock label="In scope" value={rows.length} />
        <StatBlock label="Present" value={summary.present || 0} tone="success" />
        <StatBlock label="Late" value={summary.late || 0} tone="warning" />
        <StatBlock label="Absent" value={summary.absent || 0} tone="danger" />
        <StatBlock label="On leave" value={summary.leave || 0} />
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Attendance for {date}</h3>
          <div className="flex gap-2">
            <button className="btn btn-sm"><Icon name="fileText" size={11} />PDF</button>
            <button className="btn btn-sm btn-primary" onClick={handleDownload}><Icon name="excel" size={11} />XLSX</button>
          </div>
        </div>
        <table className="table table-compact">
          <thead><tr><th>Employee</th><th>Department</th><th>Status</th><th>In</th><th>Out</th><th>Hours</th><th>OT</th><th>Flags</th></tr></thead>
          <tbody>
            {rows.slice(0, 20).map(r => (
              <tr key={r.emp.id}>
                <td><UI.PersonCell person={r.emp} hideFaces={hideFaces} subtitle={r.emp.id} /></td>
                <td className="text-sm">{r.dept?.name}</td>
                <td><UI.StatusPill status={r.status} /></td>
                <td className="mono text-sm">{r.inTime}</td>
                <td className="mono text-sm">{r.outTime}</td>
                <td className="mono text-sm">{r.hours > 0 ? `${r.hours.toFixed(1)}h` : '—'}</td>
                <td className="mono text-sm" style={{ color: r.ot > 0 ? 'var(--success-text)' : 'var(--text-tertiary)' }}>{r.ot > 0 ? `+${r.ot}h` : '—'}</td>
                <td className="text-xs text-dim">{r.rec.flags.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 20 && <div className="card-body text-xs text-dim" style={{ borderTop: '1px solid var(--border)' }}>Showing 20 of {rows.length} · download XLSX for the full list</div>}
      </div>
    </>
  );
}

/* ---------- Camera logs page ---------- */

function CameraLogsPage({ hideFaces }) {
  const { EMPLOYEES, CAMERAS = [], LIVE_EVENTS = [] } = window.APP_DATA;
  const [cam, setCam] = React.useState('all');
  const [from, setFrom] = React.useState('2026-04-23');
  const [to, setTo] = React.useState('2026-04-23');
  const [type, setType] = React.useState('all');

  // Synthesize rich log
  const logs = React.useMemo(() => {
    const out = [];
    const cams = ['CAM-01','CAM-02','CAM-03','CAM-04','CAM-05','CAM-08'];
    const locs = ['Entrance A','Entrance B','Warehouse Front','Back Gate','Finance Wing','Server Room'];
    const r = mulberry32(42);
    for (let i = 0; i < 180; i++) {
      const emp = EMPLOYEES[Math.floor(r() * EMPLOYEES.length)];
      const c = Math.floor(r() * cams.length);
      const hh = String(Math.floor(r() * 10 + 7)).padStart(2,'0');
      const mm = String(Math.floor(r() * 60)).padStart(2,'0');
      const ss = String(Math.floor(r() * 60)).padStart(2,'0');
      const conf = 0.6 + r() * 0.38;
      const identified = conf > 0.72;
      out.push({
        id: `EV-${(100000 + i).toString()}`,
        ts: `2026-04-23 ${hh}:${mm}:${ss}`,
        camera: cams[c],
        location: locs[c],
        emp: identified ? emp : null,
        conf, type: r() > 0.5 ? 'entry' : 'exit',
        matched: identified,
      });
    }
    return out.sort((a,b) => b.ts.localeCompare(a.ts));
  }, []);

  const filtered = logs.filter(l => {
    if (cam !== 'all' && l.camera !== cam) return false;
    if (type === 'matched' && !l.matched) return false;
    if (type === 'unmatched' && l.matched) return false;
    return true;
  });

  const handleDownload = () => {
    downloadXLSX(
      `camera-logs-${from}_to_${to}.xls`,
      filtered.map(l => [l.id, l.ts, l.camera, l.location, l.emp?.id || '', l.emp?.name || 'Unidentified', (l.conf*100).toFixed(1)+'%', l.type, l.matched ? 'Matched' : 'Unmatched']),
      ['Event ID','Timestamp','Camera','Location','Employee ID','Matched Name','Confidence','Event Type','Match status']
    );
    showToast(`Downloaded ${filtered.length} camera events`);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Camera logs</h1>
          <p className="page-sub">Raw detection events — every time a face was captured and compared against the reference gallery</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="filter" size={12} />Advanced filter</button>
          <button className="btn btn-primary" onClick={handleDownload}><Icon name="excel" size={12} />Download XLSX</button>
        </div>
      </div>

      {/* Pipeline explainer */}
      <div className="pipeline-explainer">
        <div className="pipe-step">
          <div className="pipe-icon"><Icon name="camera" size={18} /></div>
          <div>
            <div className="pipe-title">1 · Capture</div>
            <div className="pipe-sub">RTSP stream · face detected at ≥48px · cropped & timestamped</div>
          </div>
        </div>
        <div className="pipe-arrow"><Icon name="chevronRight" size={14} /></div>
        <div className="pipe-step">
          <div className="pipe-icon"><Icon name="sparkles" size={18} /></div>
          <div>
            <div className="pipe-title">2 · Compare</div>
            <div className="pipe-sub">Embedding vs reference gallery · cosine similarity</div>
          </div>
        </div>
        <div className="pipe-arrow"><Icon name="chevronRight" size={14} /></div>
        <div className="pipe-step">
          <div className="pipe-icon"><Icon name="check" size={18} /></div>
          <div>
            <div className="pipe-title">3 · Match</div>
            <div className="pipe-sub">Score ≥ 0.78 → identified · below → queued for review</div>
          </div>
        </div>
        <div className="pipe-arrow"><Icon name="chevronRight" size={14} /></div>
        <div className="pipe-step">
          <div className="pipe-icon"><Icon name="fileText" size={18} /></div>
          <div>
            <div className="pipe-title">4 · Attendance</div>
            <div className="pipe-sub">First entry = clock-in · last exit = clock-out · XLSX ready</div>
          </div>
        </div>
      </div>

      <div className="filter-bar">
        <div className="filter-group">
          <span className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Range</span>
          <input className="input mono sm" type="date" value={from} onChange={e => setFrom(e.target.value)} />
          <span className="text-dim">→</span>
          <input className="input mono sm" type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <select className="input sm" value={cam} onChange={e => setCam(e.target.value)}>
          <option value="all">All cameras</option>
          {['CAM-01','CAM-02','CAM-03','CAM-04','CAM-05','CAM-08'].map(c => <option key={c}>{c}</option>)}
        </select>
        <div className="seg">
          <button className={`seg-btn ${type === 'all' ? 'active' : ''}`} onClick={() => setType('all')}>All</button>
          <button className={`seg-btn ${type === 'matched' ? 'active' : ''}`} onClick={() => setType('matched')}>Matched</button>
          <button className={`seg-btn ${type === 'unmatched' ? 'active' : ''}`} onClick={() => setType('unmatched')}>Unmatched</button>
        </div>
        <div className="filter-spacer" />
        <span className="text-xs text-dim mono">{filtered.length} events</span>
      </div>

      <div className="card">
        <table className="table table-compact">
          <thead><tr><th>Event ID</th><th>Timestamp</th><th>Camera</th><th>Matched to</th><th>Confidence</th><th>Type</th><th>Status</th></tr></thead>
          <tbody>
            {filtered.slice(0, 30).map(l => (
              <tr key={l.id}>
                <td className="mono text-xs">{l.id}</td>
                <td className="mono text-sm">{l.ts}</td>
                <td className="text-sm">{l.camera} <span className="text-dim">· {l.location}</span></td>
                <td>{l.emp ? <UI.PersonCell person={l.emp} hideFaces={hideFaces} subtitle={l.emp.id} /> : <span className="text-dim text-sm"><em>Unidentified</em></span>}</td>
                <td className="mono text-sm" style={{ color: l.conf > 0.72 ? 'var(--success-text)' : 'var(--warning-text)' }}>{(l.conf * 100).toFixed(1)}%</td>
                <td><Pill kind={l.type === 'entry' ? 'success' : 'neutral'}>{l.type}</Pill></td>
                <td><Pill kind={l.matched ? 'success' : 'warning'} dot>{l.matched ? 'Matched' : 'Review'}</Pill></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="card-body text-xs text-dim" style={{ borderTop: '1px solid var(--border)' }}>Showing 30 of {filtered.length} — download XLSX for the full log</div>
      </div>
    </>
  );
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- Multi-dept manager assignment drawer ---------- */

function ManagerAssignDrawer({ onClose }) {
  const { EMPLOYEES, DEPARTMENTS } = window.APP_DATA;
  const managers = EMPLOYEES.filter(e => e.role === 'Manager' || e.role === 'Admin');
  const [selected, setSelected] = React.useState('OM0097');
  const [assigned, setAssigned] = React.useState({
    'OM0097': ['ops', 'eng'], // Sultan now manages Ops + Eng
    'OM0033': ['eng'],
    'OM0088': ['fin'],
    'OM0156': ['it'],
    'OM0302': ['hr'],
  });
  const mgr = EMPLOYEES.find(e => e.id === selected);
  const myDepts = assigned[selected] || [];
  const toggle = (dId) => setAssigned(a => ({
    ...a,
    [selected]: myDepts.includes(dId) ? myDepts.filter(x => x !== dId) : [...myDepts, dId]
  }));

  return (
    <FormDrawer title="Manager department assignments" sub="Assign one manager to multiple departments — they see attendance for all employees across assigned depts" onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => { showToast('Assignments saved'); onClose(); }}><Icon name="check" size={12} />Save assignments</button>
      </>}>
      <div className="grid" style={{ gridTemplateColumns: '260px 1fr', gap: 16 }}>
        <div>
          <div className="text-xs" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginBottom: 8 }}>Managers</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {managers.map(m => {
              const count = (assigned[m.id] || []).length;
              return (
                <button key={m.id} onClick={() => setSelected(m.id)} className={`mgr-item ${selected === m.id ? 'active' : ''}`}>
                  <div className="avatar sm" style={{ background: m.avatar }}>{m.initials}</div>
                  <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                    <div className="text-xs text-dim">{m.designation}</div>
                  </div>
                  {count > 0 && <span className="count-pill">{count}</span>}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="text-xs" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginBottom: 8 }}>
            Departments managed by {mgr.name}
          </div>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
            {DEPARTMENTS.map(d => {
              const isMine = myDepts.includes(d.id);
              const otherMgr = Object.entries(assigned).find(([k, v]) => k !== selected && v.includes(d.id));
              return (
                <label key={d.id} className={`dept-assign ${isMine ? 'on' : ''}`}>
                  <input type="checkbox" checked={isMine} onChange={() => toggle(d.id)} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{d.name}</div>
                    <div className="text-xs text-dim">{d.count} employees · head: {d.head}</div>
                    {otherMgr && <div className="text-xs" style={{ color: 'var(--warning-text)', marginTop: 2 }}>Also managed by {EMPLOYEES.find(e => e.id === otherMgr[0])?.name.split(' ')[0]}</div>}
                  </div>
                  {isMine && <Icon name="check" size={14} />}
                </label>
              );
            })}
          </div>

          <div style={{ marginTop: 16, padding: 12, background: 'var(--accent-soft)', border: '1px solid var(--accent-border)', borderRadius: 8 }}>
            <div className="text-xs" style={{ fontWeight: 600, color: 'var(--accent-text)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Effective scope</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
              {myDepts.length === 0 ? 'No departments assigned.' : <>
                {mgr.name} will see attendance, approve requests, and receive daily XLSX for{' '}
                <strong>{myDepts.length} department{myDepts.length > 1 ? 's' : ''}</strong>:{' '}
                {myDepts.map(id => DEPARTMENTS.find(d => d.id === id)?.name).join(', ')} · approximately{' '}
                <strong>{myDepts.reduce((s, id) => s + (DEPARTMENTS.find(d => d.id === id)?.count || 0), 0)} employees</strong>.
              </>}
            </div>
          </div>
        </div>
      </div>
    </FormDrawer>
  );
}

/* ---------- Capture→Compare pipeline page (product clarity) ---------- */

function PipelinePage() {
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">How Hadir works</h1>
          <p className="page-sub">Camera captures → face compared against enrolled reference → attendance XLSX generated</p>
        </div>
      </div>

      <div className="pipeline-big">
        <div className="pb-step">
          <div className="pb-num">1</div>
          <div className="pb-icon" style={{ background: 'oklch(0.96 0.03 195)', color: 'var(--accent-text)' }}><Icon name="camera" size={22} /></div>
          <h3 className="pb-title">Capture</h3>
          <p className="pb-text">CCTV cameras stream continuously. When any face appears ≥ 48px, a 160×160 crop is saved with a timestamp and the camera ID.</p>
          <div className="pb-meta">~4 fps per camera · PDPL-compliant local storage</div>
        </div>

        <div className="pb-step">
          <div className="pb-num">2</div>
          <div className="pb-icon" style={{ background: 'oklch(0.96 0.03 155)', color: 'var(--success-text)' }}><Icon name="sparkles" size={22} /></div>
          <h3 className="pb-title">Compare</h3>
          <p className="pb-text">The captured face is turned into a 512-dim embedding. We compare it against the reference photos enrolled for every employee, using cosine similarity.</p>
          <div className="pb-meta">Reference gallery built once during onboarding · re-indexed nightly</div>
        </div>

        <div className="pb-step">
          <div className="pb-num">3</div>
          <div className="pb-icon" style={{ background: 'oklch(0.96 0.04 75)', color: 'var(--warning-text)' }}><Icon name="check" size={22} /></div>
          <h3 className="pb-title">Decide</h3>
          <p className="pb-text">If similarity ≥ 0.78, we record an identified event. Below that, the capture is queued for HR review with the top-3 candidate matches.</p>
          <div className="pb-meta">Threshold configurable in Settings</div>
        </div>

        <div className="pb-step">
          <div className="pb-num">4</div>
          <div className="pb-icon" style={{ background: 'oklch(0.96 0.03 250)', color: 'var(--info-text)' }}><Icon name="fileText" size={22} /></div>
          <h3 className="pb-title">Generate</h3>
          <p className="pb-text">First identified entry of the day = clock-in, last exit = clock-out. Hours, overtime, late flags are computed against shift policy and downloaded as XLSX.</p>
          <div className="pb-meta">Daily · weekly · monthly · custom range</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18, padding: 22 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Visual walkthrough</h3>
        <div className="walkthrough">
          <div className="walk-cell">
            <div className="cam-stage sm"><div className="cam-bg" /><div className="cam-label rec">CAM-02 · Front Gate</div></div>
            <div className="walk-caption">1. Captured at 07:42:18 from CCTV</div>
          </div>
          <div className="walk-arrow"><Icon name="chevronRight" size={18} /></div>
          <div className="walk-cell">
            <div className="walk-compare">
              <div className="walk-face">
                <div style={{ width: '100%', height: '100%', background: 'radial-gradient(circle at 30% 30%, oklch(0.66 0.13 20), oklch(0.3 0.05 240))', display: 'grid', placeItems: 'center', color: 'white', fontWeight: 600 }}>FK</div>
                <span className="walk-label">capture</span>
              </div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>≈</div>
              <div className="walk-face">
                <div style={{ width: '100%', height: '100%', background: 'radial-gradient(circle at 30% 30%, oklch(0.66 0.13 20), oklch(0.3 0.05 240))', display: 'grid', placeItems: 'center', color: 'white', fontWeight: 600 }}>FK</div>
                <span className="walk-label">enrolled</span>
              </div>
            </div>
            <div className="walk-caption">2. Compared to reference gallery · score <strong>0.91</strong></div>
          </div>
          <div className="walk-arrow"><Icon name="chevronRight" size={18} /></div>
          <div className="walk-cell">
            <div className="walk-row">
              <span className="mono text-xs text-dim">OM0045</span>
              <span style={{ fontSize: 13, fontWeight: 500 }}>Fatima Al-Kindi</span>
              <Pill kind="success" dot>Identified</Pill>
            </div>
            <div className="walk-row"><span className="mono text-xs">07:42:18</span><span>→ clock-in</span></div>
            <div className="walk-caption">3. Written to attendance ledger</div>
          </div>
          <div className="walk-arrow"><Icon name="chevronRight" size={18} /></div>
          <div className="walk-cell">
            <div className="walk-xlsx">
              <div className="xlsx-head">attendance-2026-04-23.xls</div>
              <div className="xlsx-row"><span>OM0045</span><span>Fatima</span><span>Present</span><span className="mono">07:42</span></div>
              <div className="xlsx-row"><span>OM0012</span><span>Aisha</span><span>Present</span><span className="mono">07:28</span></div>
              <div className="xlsx-row"><span>OM0097</span><span>Sultan</span><span>Late</span><span className="mono">07:51</span></div>
            </div>
            <div className="walk-caption">4. XLSX ready for HR & managers</div>
          </div>
        </div>
      </div>
    </>
  );
}

window.Enhancements2 = {
  LeavePolicyPage, DailyAttendancePage, CameraLogsPage, ManagerAssignDrawer, PipelinePage,
  downloadXLSX, showToast,
};
