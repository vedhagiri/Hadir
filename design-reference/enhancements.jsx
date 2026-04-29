/* Maugood enhancements — new forms, calendar view, report builder, employee search,
   custom fields editor, mobile responsive helpers */

/* ---------- shared drawer chrome (form style) ---------- */

function FormDrawer({ title, sub, onClose, children, footer, wide }) {
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className={`drawer ${wide ? 'drawer-wide' : ''}`}>
        <div className="drawer-head">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
            {sub && <div className="text-xs text-dim" style={{ marginTop: 2 }}>{sub}</div>}
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </>
  );
}

function FormSection({ title, children, cols = 2 }) {
  return (
    <div style={{ marginBottom: 18 }}>
      {title && <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginBottom: 10 }}>{title}</div>}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 10 }}>{children}</div>
    </div>
  );
}

function Field({ label, help, full, children }) {
  return (
    <div className="field" style={{ gridColumn: full ? `1 / -1` : undefined }}>
      {label && <label className="field-label">{label}</label>}
      {children}
      {help && <span className="field-help">{help}</span>}
    </div>
  );
}

/* ---------- New Camera form ---------- */

function NewCameraDrawer({ onClose }) {
  const [step, setStep] = React.useState('config'); // config | test | calibrate
  const [status, setStatus] = React.useState('idle'); // idle | connecting | ok | fail
  const testConnection = () => {
    setStatus('connecting');
    setTimeout(() => setStatus('ok'), 900);
  };
  return (
    <FormDrawer title="Add camera" sub="Register a new RTSP source and calibrate it" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary"><Icon name="check" size={12} />Save camera</button>
      </>}>
      <div className="stepper" style={{ marginBottom: 18 }}>
        {[
          { id: 'config', label: '1 · Connection', icon: 'link' },
          { id: 'test', label: '2 · Test feed', icon: 'camera' },
          { id: 'calibrate', label: '3 · Calibrate', icon: 'crosshair' },
        ].map(s => (
          <button key={s.id} className={`stepper-btn ${step === s.id ? 'active' : ''}`} onClick={() => setStep(s.id)}>
            <Icon name={s.icon} size={12} />{s.label}
          </button>
        ))}
      </div>

      {step === 'config' && (
        <>
          <FormSection title="Identification">
            <Field label="Camera label"><input className="input" defaultValue="Warehouse Front Gate" /></Field>
            <Field label="Camera ID" help="Auto-generated; override if you want"><input className="input mono" defaultValue="CAM-09" /></Field>
            <Field label="Location"><input className="input" defaultValue="Warehouse · Front" /></Field>
            <Field label="Zone">
              <select className="input">
                <option>Entry</option><option>Exit</option><option>Internal</option><option>Perimeter</option>
              </select>
            </Field>
          </FormSection>

          <FormSection title="RTSP stream">
            <Field label="RTSP URL" full><input className="input mono" defaultValue="rtsp://admin:••••••@10.14.22.84:554/Streaming/Channels/101" /></Field>
            <Field label="Username"><input className="input mono" defaultValue="admin" /></Field>
            <Field label="Password"><input className="input mono" type="password" defaultValue="••••••••" /></Field>
            <Field label="Resolution">
              <select className="input mono"><option>1920×1080</option><option>2560×1440</option><option>1280×720</option></select>
            </Field>
            <Field label="Analyzer FPS" help="Lower = less CPU, fewer detections">
              <input className="input mono" defaultValue="4" />
            </Field>
          </FormSection>

          <FormSection title="Test connection" cols={1}>
            <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ fontSize: 12.5 }}>
                {status === 'idle' && <span className="text-secondary">Verify the stream is reachable before saving.</span>}
                {status === 'connecting' && <span className="text-secondary">Connecting to rtsp://…/101 <span className="mono">·</span> handshake in progress</span>}
                {status === 'ok' && <span style={{ color: 'var(--success-text)' }}><Icon name="check" size={12} /> Connected · 4.1 fps · 1920×1080 · codec H.264</span>}
                {status === 'fail' && <span style={{ color: 'var(--danger-text)' }}><Icon name="x" size={12} /> Auth failed</span>}
              </div>
              <button className="btn" onClick={testConnection}><Icon name={status === 'connecting' ? 'refresh' : 'play'} size={12} />{status === 'connecting' ? 'Testing…' : 'Test'}</button>
            </div>
          </FormSection>
        </>
      )}

      {step === 'test' && (
        <div>
          <div className="cam-stage" style={{ aspectRatio: '16/9', borderRadius: 10 }}>
            <div className="cam-bg" />
            <div className="cam-label rec">CAM-09 · Warehouse Front Gate</div>
            <div className="cam-timestamp mono">{new Date().toISOString().slice(11,19)} · 4.1 fps</div>
          </div>
          <div className="flex items-center justify-between mt-3" style={{ marginTop: 10 }}>
            <span className="text-xs text-dim">Stream healthy for 12 seconds. Ready to calibrate.</span>
            <button className="btn btn-primary btn-sm" onClick={() => setStep('calibrate')}>Next · Calibrate <Icon name="chevronRight" size={11} /></button>
          </div>
        </div>
      )}

      {step === 'calibrate' && (
        <>
          <FormSection title="Detection region" cols={1}>
            <div className="text-xs text-dim" style={{ marginBottom: 8 }}>Draw the polygon where faces should be detected (ignore walls, windows)</div>
            <div style={{ aspectRatio: '16/8', position: 'relative', background: 'var(--bg-sunken)', borderRadius: 8, border: '1px solid var(--border)', overflow: 'hidden' }}>
              <svg width="100%" height="100%" viewBox="0 0 400 200" preserveAspectRatio="none">
                <polygon points="60,40 340,30 360,180 40,170" fill="oklch(0.52 0.09 195 / 0.18)" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 3" />
                {[{x:60,y:40},{x:340,y:30},{x:360,y:180},{x:40,y:170}].map((p,i)=>(
                  <circle key={i} cx={p.x} cy={p.y} r="5" fill="var(--bg-elev)" stroke="var(--accent)" strokeWidth="2" />
                ))}
              </svg>
            </div>
          </FormSection>
          <FormSection title="Detection settings">
            <Field label="Min face size (px)"><input className="input mono" defaultValue="48" /></Field>
            <Field label="Confidence threshold"><input className="input mono" defaultValue="0.55" /></Field>
            <Field label="Identification threshold"><input className="input mono" defaultValue="0.78" /></Field>
            <Field label="De-duplication window (s)"><input className="input mono" defaultValue="30" /></Field>
          </FormSection>
          <FormSection title="Associate to policy" cols={1}>
            <Field label="This camera's events count as">
              <select className="input"><option>Entry event (counts as clock-in)</option><option>Exit event (counts as clock-out)</option><option>Presence only (no clock effect)</option></select>
            </Field>
          </FormSection>
        </>
      )}
    </FormDrawer>
  );
}

/* ---------- New Request form ---------- */

function NewRequestDrawer({ role, currentUserId, onClose }) {
  const { EMPLOYEES } = window.APP_DATA;
  const empById = Object.fromEntries(EMPLOYEES.map(e => [e.id, e]));
  const isSelf = role === 'Employee';
  const [type, setType] = React.useState('Late-in');
  const [forEmp, setForEmp] = React.useState(currentUserId || EMPLOYEES[2].id);

  return (
    <FormDrawer title="New attendance request" sub="Submits to the approval chain (Manager → HR)" onClose={onClose}
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn"><Icon name="fileText" size={12} />Save draft</button>
        <button className="btn btn-accent"><Icon name="check" size={12} />Submit</button>
      </>}>
      <FormSection title="Who & what">
        {!isSelf && (
          <Field label="Employee" full>
            <div style={{ position: 'relative' }}>
              <select className="input" value={forEmp} onChange={e => setForEmp(e.target.value)}>
                {EMPLOYEES.filter(e => e.role === 'Employee' || e.role === 'Manager').map(e => (
                  <option key={e.id} value={e.id}>{e.name} · {e.id} · {e.designation}</option>
                ))}
              </select>
            </div>
          </Field>
        )}
        <Field label="Request type" full>
          <div className="radio-row">
            {[
              { v: 'Late-in', icon: 'clock', hint: 'Arriving later than shift start' },
              { v: 'Early-out', icon: 'logout', hint: 'Leaving before shift end' },
              { v: 'Absence', icon: 'calendar', hint: 'Full day or multi-day' },
              { v: 'Correction', icon: 'edit', hint: 'Fix a missed detection' },
            ].map(opt => (
              <label key={opt.v} className={`radio-card ${type === opt.v ? 'active' : ''}`}>
                <input type="radio" name="reqtype" checked={type === opt.v} onChange={() => setType(opt.v)} />
                <Icon name={opt.icon} size={14} />
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 500 }}>{opt.v}</div>
                  <div className="text-xs text-dim">{opt.hint}</div>
                </div>
              </label>
            ))}
          </div>
        </Field>
      </FormSection>

      <FormSection title="When">
        {type === 'Absence' ? (
          <>
            <Field label="From"><input className="input mono" type="date" defaultValue="2026-04-24" /></Field>
            <Field label="To"><input className="input mono" type="date" defaultValue="2026-04-25" /></Field>
          </>
        ) : (
          <>
            <Field label="Date"><input className="input mono" type="date" defaultValue="2026-04-24" /></Field>
            <Field label={type === 'Late-in' ? 'Expected arrival' : type === 'Early-out' ? 'Expected departure' : 'Time'}>
              <input className="input mono" type="time" defaultValue={type === 'Late-in' ? '08:30' : '14:00'} />
            </Field>
          </>
        )}
      </FormSection>

      <FormSection title="Reason" cols={1}>
        <Field label="Category" full>
          <select className="input">
            <option>Medical — personal</option><option>Medical — family</option><option>Government appointment</option>
            <option>Transportation</option><option>Family emergency</option><option>Personal</option><option>Other</option>
          </select>
        </Field>
        <Field label="Details for the approver" full help="Your manager and HR will see this" >
          <textarea className="textarea" rows="3" placeholder="Cardiologist follow-up at 09:00. Expected to be 45 minutes late."></textarea>
        </Field>
        <Field label="Attachment" full help="PDF, PNG, or JPG · max 5 MB">
          <div className="dropzone sm">
            <Icon name="upload" size={16} />
            <span>Drop file or <u>browse</u></span>
          </div>
        </Field>
      </FormSection>

      <FormSection title="Approval chain" cols={1}>
        <div className="chain-mini">
          <div className="chain-mini-step done"><div className="cm-dot"><Icon name="check" size={11} /></div><div className="cm-name">You</div><div className="cm-sub">{isSelf ? 'Self' : empById[forEmp]?.name}</div></div>
          <div className="cm-bar" />
          <div className="chain-mini-step active"><div className="cm-dot">2</div><div className="cm-name">Manager</div><div className="cm-sub">{empById[empById[forEmp]?.mgr]?.name || 'Line manager'}</div></div>
          <div className="cm-bar" />
          <div className="chain-mini-step"><div className="cm-dot">3</div><div className="cm-name">HR</div><div className="cm-sub">Aisha Al-Habsi</div></div>
        </div>
      </FormSection>
    </FormDrawer>
  );
}

/* ---------- New Report form (with cron schedule preview) ---------- */

function NewReportDrawer({ onClose }) {
  const { EMPLOYEES, DEPARTMENTS } = window.APP_DATA;
  const [schedule, setSchedule] = React.useState('on-demand');
  const [freq, setFreq] = React.useState('daily');
  const [time, setTime] = React.useState('08:00');
  const [dow, setDow] = React.useState('sun');
  const [dom, setDom] = React.useState('1');
  const [format, setFormat] = React.useState('xlsx');

  const cron = React.useMemo(() => {
    const [h, m] = time.split(':');
    const dowIdx = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 }[dow];
    if (schedule === 'on-demand') return null;
    if (freq === 'daily')   return `${m} ${h} * * *`;
    if (freq === 'weekly')  return `${m} ${h} * * ${dowIdx}`;
    if (freq === 'monthly') return `${m} ${h} ${dom} * *`;
    if (freq === 'hourly')  return `0 * * * *`;
    return '';
  }, [schedule, freq, time, dow, dom]);

  const nextRuns = React.useMemo(() => {
    if (!cron) return [];
    // Fake: produce next 3 ISO timestamps
    const base = new Date('2026-04-24T00:00:00');
    const [h, m] = time.split(':');
    const out = [];
    const dowIdx = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 }[dow];
    let d = new Date(base);
    d.setHours(+h, +m, 0, 0);
    while (out.length < 3) {
      if (d > base) {
        if (freq === 'daily') out.push(new Date(d));
        else if (freq === 'weekly' && d.getDay() === dowIdx) out.push(new Date(d));
        else if (freq === 'monthly' && d.getDate() === +dom) out.push(new Date(d));
        else if (freq === 'hourly') out.push(new Date(d));
      }
      if (freq === 'hourly') d.setHours(d.getHours() + 1); else d.setDate(d.getDate() + 1);
      if (out.length > 10) break;
    }
    return out;
  }, [cron, freq, time, dow, dom]);

  return (
    <FormDrawer title="New attendance report" sub="Define columns, scope, delivery, and schedule" onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn"><Icon name="play" size={12} />Run once now</button>
        <button className="btn btn-primary"><Icon name="check" size={12} />Save report</button>
      </>}>

      <FormSection title="Basics">
        <Field label="Report name"><input className="input" defaultValue="HR Daily Attendance" /></Field>
        <Field label="Type">
          <select className="input">
            <option>Daily Attendance (per-person per-day)</option>
            <option>Event Log (per-detection)</option>
            <option>Department Summary (aggregated)</option>
            <option>Approvals Report</option>
            <option>Exceptions Digest (late/absent/OT)</option>
            <option>Camera Uptime</option>
          </select>
        </Field>
      </FormSection>

      <FormSection title="Scope">
        <Field label="Date range">
          <select className="input">
            <option>Rolling: yesterday</option>
            <option>Rolling: last 7 days</option>
            <option>Rolling: last 30 days</option>
            <option>Rolling: this month</option>
            <option>Custom…</option>
          </select>
        </Field>
        <Field label="Departments">
          <select className="input"><option>All ({DEPARTMENTS.length})</option>{DEPARTMENTS.map(d => <option key={d.id}>{d.name}</option>)}</select>
        </Field>
        <Field label="Employees">
          <select className="input"><option>All ({EMPLOYEES.length})</option><option>By tag…</option><option>Specific list…</option></select>
        </Field>
        <Field label="Include statuses">
          <select className="input"><option>All (present, late, absent, leave, holiday)</option><option>Exceptions only (late, absent, OT)</option></select>
        </Field>
      </FormSection>

      <FormSection title="Columns" cols={1}>
        <div className="chip-grid">
          {['Employee ID','Name','Department','Designation','Shift policy','In time','Out time','Total hours','Overtime','Late minutes','Flags','Camera(s)','Manager','Notes'].map((c, i) => (
            <label key={c} className={`chip-toggle ${i < 10 ? 'on' : ''}`}>
              <input type="checkbox" defaultChecked={i < 10} />{c}
            </label>
          ))}
        </div>
      </FormSection>

      <FormSection title="Format & delivery">
        <Field label="Format">
          <div className="radio-row">
            {[
              { v: 'xlsx', label: 'XLSX', sub: 'Excel · editable', icon: 'excel' },
              { v: 'csv',  label: 'CSV',  sub: 'Raw, universal',   icon: 'fileText' },
              { v: 'pdf',  label: 'PDF',  sub: 'Print-ready',      icon: 'fileText' },
            ].map(f => (
              <label key={f.v} className={`radio-card ${format === f.v ? 'active' : ''}`}>
                <input type="radio" name="fmt" checked={format === f.v} onChange={() => setFormat(f.v)} />
                <Icon name={f.icon} size={14} />
                <div><div style={{ fontSize: 12.5, fontWeight: 500 }}>{f.label}</div><div className="text-xs text-dim">{f.sub}</div></div>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Delivery">
          <select className="input"><option>Email attachment</option><option>Email with download link</option><option>Save to SFTP</option><option>Download link only</option></select>
        </Field>
        <Field label="Recipients" full>
          <input className="input" defaultValue="hr-all@omran.om, it-ops@omran.om" />
        </Field>
      </FormSection>

      <FormSection title="Schedule">
        <Field label="When to run" full>
          <div className="radio-row">
            {[
              { v: 'on-demand', label: 'On-demand only' },
              { v: 'scheduled', label: 'Scheduled (cron)' },
            ].map(o => (
              <label key={o.v} className={`radio-card ${schedule === o.v ? 'active' : ''}`}>
                <input type="radio" name="when" checked={schedule === o.v} onChange={() => setSchedule(o.v)} />
                <div style={{ fontSize: 12.5, fontWeight: 500 }}>{o.label}</div>
              </label>
            ))}
          </div>
        </Field>

        {schedule === 'scheduled' && (
          <>
            <Field label="Frequency">
              <select className="input" value={freq} onChange={e => setFreq(e.target.value)}>
                <option value="hourly">Hourly</option><option value="daily">Daily</option>
                <option value="weekly">Weekly</option><option value="monthly">Monthly</option>
              </select>
            </Field>
            {freq !== 'hourly' && <Field label="Time"><input className="input mono" type="time" value={time} onChange={e => setTime(e.target.value)} /></Field>}
            {freq === 'weekly' && (
              <Field label="Day of week">
                <select className="input" value={dow} onChange={e => setDow(e.target.value)}>
                  <option value="sun">Sunday</option><option value="mon">Monday</option><option value="tue">Tuesday</option>
                  <option value="wed">Wednesday</option><option value="thu">Thursday</option><option value="fri">Friday</option><option value="sat">Saturday</option>
                </select>
              </Field>
            )}
            {freq === 'monthly' && <Field label="Day of month"><input className="input mono" type="number" min="1" max="31" value={dom} onChange={e => setDom(e.target.value)} /></Field>}
            <Field label="Timezone"><select className="input"><option>Asia/Muscat (GST +04:00)</option></select></Field>

            <div style={{ gridColumn: '1 / -1', padding: 12, background: 'var(--bg-sunken)', borderRadius: 8, marginTop: 6 }}>
              <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                <span className="text-xs" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, color: 'var(--text-tertiary)' }}>Cron expression</span>
                <span className="mono" style={{ fontSize: 13, color: 'var(--accent-text)' }}>{cron}</span>
              </div>
              <div className="text-xs text-dim" style={{ marginBottom: 6 }}>Next runs in Asia/Muscat</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {nextRuns.slice(0, 3).map((d, i) => (
                  <div key={i} className="mono text-xs" style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{d.toISOString().slice(0, 10)} · {d.toTimeString().slice(0, 5)}</span>
                    <span className="text-dim">{['next','then','then'][i]}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </FormSection>
    </FormDrawer>
  );
}

/* ---------- Calendar view (full month) ---------- */

function AttendanceCalendarPage({ hideFaces, onOpenRecord, defaultPerson }) {
  const { EMPLOYEES, HOLIDAYS_2026, genAttendance } = window.APP_DATA;
  const [month, setMonth] = React.useState(new Date('2026-04-01'));
  const [scope, setScope] = React.useState(defaultPerson ? 'person' : 'company'); // company | person
  const [person, setPerson] = React.useState(defaultPerson || EMPLOYEES[2].id);
  const [query, setQuery] = React.useState('');
  const matches = React.useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return EMPLOYEES.slice(0, 6);
    return EMPLOYEES.filter(e => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)).slice(0, 6);
  }, [query]);

  const prevMonth = () => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  const nextMonth = () => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1));

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const startPad = first.getDay(); // Sun=0
  const cells = [];
  for (let i = 0; i < startPad; i++) cells.push(null);
  for (let d = 1; d <= last.getDate(); d++) cells.push(new Date(month.getFullYear(), month.getMonth(), d));
  while (cells.length % 7) cells.push(null);

  const attendance = React.useMemo(() => genAttendance(person === 'OM0045' ? 7 : person.charCodeAt(3) * 13), [person]);
  const byISO = Object.fromEntries(attendance.map(a => [a.date.toISOString().slice(0,10), a]));
  const holidayByISO = Object.fromEntries(HOLIDAYS_2026.map(h => [h.date, h]));

  const selectedEmp = EMPLOYEES.find(e => e.id === person);

  const statusColor = (s) => ({
    present: { bg: 'var(--success-soft)', dot: 'var(--success)', label: 'P' },
    late: { bg: 'var(--warning-soft)', dot: 'var(--warning)', label: 'L' },
    absent: { bg: 'var(--danger-soft)', dot: 'var(--danger)', label: 'A' },
    leave: { bg: 'var(--info-soft)', dot: 'var(--info)', label: 'V' },
    holiday: { bg: 'var(--bg-sunken)', dot: 'var(--text-tertiary)', label: 'H' },
    weekend: { bg: 'transparent', dot: 'var(--border)', label: '' },
  }[s] || { bg: 'var(--bg-sunken)', dot: 'var(--text-tertiary)', label: '' });

  // Company view: aggregate stats per day
  const companyDay = (iso) => {
    if (!iso) return null;
    const dow = new Date(iso).getDay();
    if (dow === 5 || dow === 6) return { present: 0, late: 0, absent: 0, pct: null, weekend: true };
    if (holidayByISO[iso]) return { present: 0, late: 0, absent: 0, pct: null, holiday: true };
    const seed = parseInt(iso.replaceAll('-',''));
    const rnd = mulberry32Local(seed);
    const total = 106;
    const late = Math.floor(rnd() * 10 + 2);
    const absent = Math.floor(rnd() * 5);
    const present = total - late - absent;
    return { present, late, absent, pct: (present + late) / total };
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance calendar</h1>
          <p className="page-sub">
            {scope === 'company' ? 'Company-wide presence by day' : `${selectedEmp?.name} · ${selectedEmp?.id} · last 30 days indexed`}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={12} />Export month</button>
          <button className="btn btn-primary"><Icon name="plus" size={12} />New request</button>
        </div>
      </div>

      {/* Filter / scope bar */}
      <div className="filter-bar">
        <div className="seg">
          <button className={`seg-btn ${scope === 'company' ? 'active' : ''}`} onClick={() => setScope('company')}><Icon name="building" size={11} /> Company</button>
          <button className={`seg-btn ${scope === 'person' ? 'active' : ''}`} onClick={() => setScope('person')}><Icon name="user" size={11} /> Per person</button>
        </div>
        {scope === 'person' && (
          <div className="person-search">
            <Icon name="search" size={12} />
            <input placeholder="Search employee by ID or name…" value={query} onChange={e => setQuery(e.target.value)} />
            {selectedEmp && !query && <span className="person-chip"><UI.FaceThumb person={selectedEmp} hideFaces={hideFaces} />{selectedEmp.name}<span className="mono text-dim">{selectedEmp.id}</span></span>}
            {query && (
              <div className="person-search-results">
                {matches.map(m => (
                  <div key={m.id} className="person-search-row" onClick={() => { setPerson(m.id); setQuery(''); }}>
                    <UI.FaceThumb person={m} hideFaces={hideFaces} />
                    <div><div style={{ fontSize: 12.5, fontWeight: 500 }}>{m.name}</div><div className="mono text-xs text-dim">{m.id} · {m.designation}</div></div>
                  </div>
                ))}
                {matches.length === 0 && <div className="text-xs text-dim" style={{ padding: 12 }}>No matches</div>}
              </div>
            )}
          </div>
        )}
        <div className="filter-spacer" />
        <div className="filter-group">
          <button className="btn btn-sm" onClick={prevMonth}><Icon name="chevronLeft" size={11} /></button>
          <div style={{ fontSize: 13, fontWeight: 600, minWidth: 160, textAlign: 'center' }}>
            {month.toLocaleString('en-US', { month: 'long', year: 'numeric' })}
          </div>
          <button className="btn btn-sm" onClick={nextMonth}><Icon name="chevronRight" size={11} /></button>
          <button className="btn btn-sm btn-ghost" onClick={() => setMonth(new Date('2026-04-01'))}>Today</button>
        </div>
      </div>

      {/* Calendar grid */}
      <div className="card" style={{ padding: 0 }}>
        <div className="cal-head">
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => <div key={d} className="cal-head-cell">{d}</div>)}
        </div>
        <div className="cal-grid">
          {cells.map((d, i) => {
            if (!d) return <div key={i} className="cal-cell cal-cell-empty" />;
            const iso = d.toISOString().slice(0,10);
            const holiday = holidayByISO[iso];
            const dow = d.getDay();
            const isWeekend = dow === 5 || dow === 6;

            if (scope === 'company') {
              const stat = companyDay(iso);
              return (
                <div key={i} className={`cal-cell ${isWeekend ? 'weekend' : ''}`}>
                  <div className="cal-date">
                    <span>{d.getDate()}</span>
                    {holiday && <span className="cal-tag holiday">{holiday.name}</span>}
                    {isWeekend && !holiday && <span className="cal-tag muted">Weekend</span>}
                  </div>
                  {stat && !stat.weekend && !stat.holiday && (
                    <>
                      <div className="cal-pct">{Math.round(stat.pct * 100)}%</div>
                      <div className="cal-bars">
                        <span style={{ flex: stat.present, background: 'var(--success)' }} title={`${stat.present} present`} />
                        <span style={{ flex: stat.late, background: 'var(--warning)' }} title={`${stat.late} late`} />
                        <span style={{ flex: stat.absent, background: 'var(--danger)' }} title={`${stat.absent} absent`} />
                      </div>
                      <div className="cal-nums mono">
                        <span style={{ color: 'var(--success-text)' }}>{stat.present}</span>·
                        <span style={{ color: 'var(--warning-text)' }}>{stat.late}</span>·
                        <span style={{ color: 'var(--danger-text)' }}>{stat.absent}</span>
                      </div>
                    </>
                  )}
                  {stat && stat.holiday && <div className="text-xs text-dim" style={{ marginTop: 10, fontStyle: 'italic' }}>Public holiday</div>}
                </div>
              );
            } else {
              const rec = byISO[iso];
              const s = rec ? statusColor(rec.status) : statusColor('absent');
              return (
                <div key={i} className={`cal-cell person ${isWeekend ? 'weekend' : ''}`} onClick={() => rec && onOpenRecord && onOpenRecord(selectedEmp, rec)} style={{ cursor: rec && !isWeekend ? 'pointer' : 'default', background: s.bg }}>
                  <div className="cal-date">
                    <span>{d.getDate()}</span>
                    {holiday && <span className="cal-tag holiday">{holiday.name.slice(0, 10)}</span>}
                  </div>
                  {rec && !isWeekend && rec.status !== 'holiday' && (
                    <>
                      <div style={{ fontSize: 10.5, color: s.dot, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 6 }}>{rec.status}</div>
                      {rec.inTime !== '—' && (
                        <div className="mono text-xs" style={{ marginTop: 6, color: 'var(--text-secondary)' }}>
                          {rec.inTime} → {rec.outTime}
                        </div>
                      )}
                      {rec.flags.length > 0 && <div className="text-xs text-dim" style={{ marginTop: 2 }}>{rec.flags[0]}</div>}
                    </>
                  )}
                </div>
              );
            }
          })}
        </div>
        <div className="cal-legend">
          <span><span className="dot" style={{ background: 'var(--success)' }} />Present</span>
          <span><span className="dot" style={{ background: 'var(--warning)' }} />Late</span>
          <span><span className="dot" style={{ background: 'var(--danger)' }} />Absent</span>
          <span><span className="dot" style={{ background: 'var(--info)' }} />Leave</span>
          <span><span className="dot" style={{ background: 'var(--text-tertiary)' }} />Holiday / Weekend</span>
        </div>
      </div>

      {scope === 'person' && <PersonReportSummary person={selectedEmp} attendance={attendance} hideFaces={hideFaces} />}
    </>
  );
}

function mulberry32Local(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- Employee detail report ---------- */

function EmployeeReportPage({ hideFaces, onOpenRecord }) {
  const { EMPLOYEES, DEPARTMENTS, genAttendance } = window.APP_DATA;
  const [query, setQuery] = React.useState('');
  const [person, setPerson] = React.useState('OM0045');
  const [from, setFrom] = React.useState('2026-04-01');
  const [to, setTo] = React.useState('2026-04-23');

  const emp = EMPLOYEES.find(e => e.id === person);
  const dept = DEPARTMENTS.find(d => d.id === emp?.dept);
  const mgr = EMPLOYEES.find(e => e.id === emp?.mgr);
  const attendance = React.useMemo(() => genAttendance(emp.id.charCodeAt(3) * 13), [person]);
  const filtered = attendance.filter(a => {
    const iso = a.date.toISOString().slice(0,10);
    return iso >= from && iso <= to;
  });

  const summary = React.useMemo(() => {
    const counts = { present: 0, late: 0, absent: 0, leave: 0, holiday: 0, weekend: 0 };
    let hours = 0, ot = 0;
    filtered.forEach(a => { counts[a.status] = (counts[a.status] || 0) + 1; hours += a.hours; ot += a.overtime; });
    return { ...counts, hours: hours.toFixed(1), ot: ot.toFixed(1), working: filtered.length - counts.weekend - counts.holiday };
  }, [filtered]);

  const matches = React.useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return [];
    return EMPLOYEES.filter(e => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)).slice(0, 8);
  }, [query]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Employee report</h1>
          <p className="page-sub">Search any employee and get their complete attendance for a selected range</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="excel" size={12} />Download XLSX</button>
          <button className="btn"><Icon name="fileText" size={12} />PDF</button>
        </div>
      </div>

      {/* Search + filter */}
      <div className="filter-bar">
        <div className="person-search big">
          <Icon name="search" size={13} />
          <input placeholder="Search employee by ID (e.g. OM0045) or name…" value={query} onChange={e => setQuery(e.target.value)} />
          {query && (
            <div className="person-search-results">
              {matches.map(m => (
                <div key={m.id} className="person-search-row" onClick={() => { setPerson(m.id); setQuery(''); }}>
                  <UI.FaceThumb person={m} hideFaces={hideFaces} />
                  <div>
                    <div style={{ fontSize: 12.5, fontWeight: 500 }}>{m.name}</div>
                    <div className="mono text-xs text-dim">{m.id} · {m.designation} · {DEPARTMENTS.find(d => d.id === m.dept)?.name}</div>
                  </div>
                </div>
              ))}
              {matches.length === 0 && <div className="text-xs text-dim" style={{ padding: 12 }}>No matches</div>}
            </div>
          )}
        </div>
        <div className="filter-group">
          <span className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>Range</span>
          <input className="input mono sm" type="date" value={from} onChange={e => setFrom(e.target.value)} />
          <span className="text-dim">→</span>
          <input className="input mono sm" type="date" value={to} onChange={e => setTo(e.target.value)} />
          <div className="seg">
            {[{id:'7d', label:'7d', days:7}, {id:'30d', label:'30d', days:30}, {id:'mtd', label:'MTD', days:23}].map(p => (
              <button key={p.id} className="seg-btn" onClick={() => {
                const base = new Date('2026-04-23');
                const start = new Date(base); start.setDate(base.getDate() - p.days + 1);
                setFrom(start.toISOString().slice(0,10)); setTo(base.toISOString().slice(0,10));
              }}>{p.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* Header card */}
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div className="flex items-center gap-3">
          <UI.FaceThumb person={emp} size="xl" hideFaces={hideFaces} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 500, letterSpacing: '-0.01em' }}>{emp.name}</div>
            <div className="text-sm text-secondary" style={{ marginTop: 2 }}>
              <span className="mono">{emp.id}</span> · {emp.designation} · {dept?.name} · reports to {mgr?.name || '—'}
            </div>
            <div className="flex gap-2 mt-2" style={{ marginTop: 8 }}>
              <Pill kind="accent">{emp.policy}</Pill>
              <Pill kind="neutral">{emp.role}</Pill>
              <span className="text-xs text-dim">{from} → {to} · {filtered.length} days</span>
            </div>
          </div>
          <button className="btn btn-primary"><Icon name="plus" size={12} />Raise request</button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-5" style={{ marginBottom: 16 }}>
        <StatBlock label="Working days" value={summary.working} tone="default" />
        <StatBlock label="Present" value={summary.present + summary.late} tone="success" sub={`${Math.round(((summary.present + summary.late) / Math.max(1, summary.working)) * 100)}% of working`} />
        <StatBlock label="Late" value={summary.late} tone="warning" />
        <StatBlock label="Absent" value={summary.absent} tone="danger" />
        <StatBlock label="Total hours" value={summary.hours} tone="default" sub={`+${summary.ot}h OT`} />
      </div>

      {/* Details table */}
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Day-by-day breakdown</h3>
          <div className="flex gap-2">
            <button className="btn btn-sm btn-ghost"><Icon name="filter" size={11} />Show weekends</button>
            <button className="btn btn-sm"><Icon name="download" size={11} />XLSX</button>
          </div>
        </div>
        <table className="table table-compact">
          <thead><tr><th>Date</th><th>Day</th><th>Status</th><th>In</th><th>Out</th><th>Hours</th><th>Overtime</th><th>Flags</th><th>Cameras</th><th></th></tr></thead>
          <tbody>
            {filtered.filter(a => a.status !== 'weekend').map((a, i) => {
              const iso = a.date.toISOString().slice(0,10);
              return (
                <tr key={iso} onClick={() => onOpenRecord && onOpenRecord(emp, a)} style={{ cursor: 'pointer' }}>
                  <td className="mono text-sm">{iso}</td>
                  <td className="text-sm text-dim">{a.date.toLocaleDateString('en-US', { weekday: 'short' })}</td>
                  <td><UI.StatusPill status={a.status} /></td>
                  <td className="mono text-sm">{a.inTime}</td>
                  <td className="mono text-sm">{a.outTime}</td>
                  <td className="mono text-sm">{a.hours > 0 ? a.hours.toFixed(1) + 'h' : '—'}</td>
                  <td className="mono text-sm" style={{ color: a.overtime > 0 ? 'var(--success-text)' : 'var(--text-dim)' }}>{a.overtime > 0 ? `+${a.overtime}h` : '—'}</td>
                  <td className="text-xs">{a.flags.length > 0 ? a.flags.join(', ') : <span className="text-dim">—</span>}</td>
                  <td className="text-xs text-dim">{a.status === 'present' || a.status === 'late' ? 'CAM-01, CAM-08' : '—'}</td>
                  <td style={{ textAlign: 'right' }}><Icon name="chevronRight" size={12} className="text-dim" /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StatBlock({ label, value, tone = 'default', sub }) {
  const tones = {
    default: { bg: 'var(--bg-elev)', text: 'var(--text)' },
    success: { bg: 'var(--success-soft)', text: 'var(--success-text)' },
    warning: { bg: 'var(--warning-soft)', text: 'var(--warning-text)' },
    danger:  { bg: 'var(--danger-soft)',  text: 'var(--danger-text)' },
  }[tone];
  return (
    <div className="stat" style={{ background: tones.bg }}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color: tones.text }}>{value}</div>
      {sub && <div className="text-xs text-dim" style={{ marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function PersonReportSummary({ person, attendance, hideFaces }) {
  const totals = attendance.reduce((acc, a) => { acc[a.status] = (acc[a.status] || 0) + 1; return acc; }, {});
  return (
    <div className="card mt-3" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h3 className="card-title">30-day summary</h3>
        <button className="btn btn-sm"><Icon name="download" size={11} />XLSX</button>
      </div>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
        {[
          { k: 'present', label: 'Present' },
          { k: 'late', label: 'Late' },
          { k: 'absent', label: 'Absent' },
          { k: 'leave', label: 'Leave' },
          { k: 'holiday', label: 'Holiday' },
          { k: 'weekend', label: 'Weekends' },
        ].map(s => (
          <div key={s.k} style={{ padding: 10, background: 'var(--bg-sunken)', borderRadius: 8 }}>
            <div className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{s.label}</div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 500, marginTop: 2 }}>{totals[s.k] || 0}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Custom fields editor (Settings) ---------- */

function CustomFieldsPage() {
  const [fields, setFields] = React.useState([
    { id: 'cf1', name: 'National ID', type: 'text', required: true, scope: 'Employee', visibleTo: 'HR' },
    { id: 'cf2', name: 'Emergency contact', type: 'phone', required: true, scope: 'Employee', visibleTo: 'HR, Manager' },
    { id: 'cf3', name: 'T-shirt size', type: 'select', required: false, scope: 'Employee', visibleTo: 'HR', options: 'S, M, L, XL' },
    { id: 'cf4', name: 'Badge number', type: 'text', required: true, scope: 'Employee', visibleTo: 'All' },
    { id: 'cf5', name: 'Joining date', type: 'date', required: true, scope: 'Employee', visibleTo: 'HR' },
  ]);
  const [company, setCompany] = React.useState({
    name: 'Omran',
    timezone: 'Asia/Muscat (GST +04:00)',
    weekEnd: 'Friday, Saturday',
    lateGraceMin: 10,
    otThresholdMin: 15,
    identifyThreshold: 0.78,
    dedupWindowS: 30,
    pdpl: true,
    retentionDays: 90,
  });
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings & custom fields</h1>
          <p className="page-sub">Define extra employee attributes · tune system thresholds · compliance</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="refresh" size={12} />Reset</button>
          <button className="btn btn-primary"><Icon name="check" size={12} />Save all</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Custom fields on employee record</h3>
            <button className="btn btn-sm btn-primary"><Icon name="plus" size={11} />Add field</button>
          </div>
          <table className="table table-compact">
            <thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Visible to</th><th>Config</th><th></th></tr></thead>
            <tbody>
              {fields.map(f => (
                <tr key={f.id}>
                  <td style={{ fontSize: 12.5, fontWeight: 500 }}>{f.name}</td>
                  <td><Pill kind="neutral">{f.type}</Pill></td>
                  <td>{f.required ? <Pill kind="success">Yes</Pill> : <span className="text-dim text-xs">No</span>}</td>
                  <td className="text-sm">{f.visibleTo}</td>
                  <td className="text-xs text-dim">{f.options || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn btn-sm btn-ghost"><Icon name="edit" size={11} /></button>
                    <button className="btn btn-sm btn-ghost"><Icon name="trash" size={11} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="card-body" style={{ borderTop: '1px solid var(--border)', background: 'var(--bg-sunken)' }}>
            <div className="text-xs text-dim">
              Fields appear on employee profiles and can be used as report columns. Types: text, number, date, phone, email, select, multi-select, boolean.
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h3 className="card-title">System configuration</h3></div>
          <div className="card-body">
            <FormSection title="Organization">
              <Field label="Company name"><input className="input" value={company.name} onChange={e => setCompany({...company, name: e.target.value})} /></Field>
              <Field label="Timezone"><select className="input"><option>{company.timezone}</option></select></Field>
              <Field label="Weekend days"><input className="input" value={company.weekEnd} onChange={e => setCompany({...company, weekEnd: e.target.value})} /></Field>
              <Field label="Language default"><select className="input"><option>English</option><option>Arabic</option></select></Field>
            </FormSection>

            <FormSection title="Attendance rules">
              <Field label="Late grace (min)" help="Don't flag if within"><input className="input mono" type="number" value={company.lateGraceMin} onChange={e => setCompany({...company, lateGraceMin: +e.target.value})} /></Field>
              <Field label="OT threshold (min)"><input className="input mono" type="number" value={company.otThresholdMin} onChange={e => setCompany({...company, otThresholdMin: +e.target.value})} /></Field>
              <Field label="Identify threshold"><input className="input mono" type="number" step="0.01" value={company.identifyThreshold} onChange={e => setCompany({...company, identifyThreshold: +e.target.value})} /></Field>
              <Field label="Dedup window (s)"><input className="input mono" type="number" value={company.dedupWindowS} onChange={e => setCompany({...company, dedupWindowS: +e.target.value})} /></Field>
            </FormSection>

            <FormSection title="Privacy & retention" cols={1}>
              <Field label="Event retention" help="Face crops deleted after this period">
                <div className="flex items-center gap-2">
                  <input className="input mono" style={{ width: 100 }} type="number" value={company.retentionDays} onChange={e => setCompany({...company, retentionDays: +e.target.value})} />
                  <span className="text-xs text-dim">days</span>
                </div>
              </Field>
              <label className="flex items-center gap-2" style={{ fontSize: 12.5, padding: 10, background: 'var(--bg-sunken)', borderRadius: 8 }}>
                <input type="checkbox" checked={company.pdpl} onChange={e => setCompany({...company, pdpl: e.target.checked})} />
                <span>Enforce Oman PDPL mode — hash face embeddings at rest, audit all access</span>
              </label>
            </FormSection>
          </div>
        </div>
      </div>
    </>
  );
}

window.Enhancements = {
  NewCameraDrawer, NewRequestDrawer, NewReportDrawer,
  AttendanceCalendarPage, EmployeeReportPage, CustomFieldsPage,
  FormDrawer, FormSection, Field,
};
