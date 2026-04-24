/* Live capture feed, approvals drawer, attendance detail drawer, policy editor, enrollment, reports */

function LiveCapture({ hideFaces }) {
  const { CAMERAS, LIVE_EVENTS, EMPLOYEES } = window.APP_DATA;
  const [activeCam, setActiveCam] = React.useState('CAM-01');
  const [paused, setPaused] = React.useState(false);
  const cam = CAMERAS.find(c => c.id === activeCam);
  const empById = Object.fromEntries(EMPLOYEES.map(e => [e.id, e]));

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Live capture</h1>
          <p className="page-sub">Real-time face detection · motion-skip optimised · analyzer <span className="mono">{cam.fps.toFixed(1)} fps</span></p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setPaused(p => !p)}>
            <Icon name={paused ? 'play' : 'pause'} size={12} />{paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn"><Icon name="refresh" size={12} />Reconnect</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', marginBottom: 16 }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className="cam-stage" style={{ aspectRatio: '16 / 8.2' }}>
            <div className="cam-bg" />
            <div className="cam-label rec">{cam.id} · {cam.name}</div>
            <div className="cam-timestamp">{new Date().toISOString().slice(11, 19)} · {cam.fps.toFixed(1)} fps</div>
            {/* Simulated scene: 3 people walking through */}
            <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 50% 75%, rgba(200,180,120,0.1), transparent 60%)' }} />
            {/* Floor line */}
            <div style={{ position: 'absolute', left: 0, right: 0, top: '68%', height: 1, background: 'rgba(255,255,255,0.08)' }} />
            {[
              { x: 22, y: 38, w: 10, h: 14, conf: 0.97, name: 'Fatima Al-Kindi', id: 'OM0045' },
              { x: 48, y: 32, w: 11, h: 16, conf: 0.94, name: 'Hassan Al-Balushi', id: 'OM0128' },
              { x: 72, y: 42, w: 9, h: 13, conf: 0.48, name: 'Unknown', id: null },
            ].map((b, i) => (
              <div key={i} className={`bbox ${b.id ? 'id-known' : 'id-unknown'}`} style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` }}>
                <div className="bbox-label">{b.id ? `${b.name} · ${(b.conf*100).toFixed(0)}%` : `Unknown · ${(b.conf*100).toFixed(0)}%`}</div>
              </div>
            ))}
            {/* Simulated people silhouettes */}
            {[{x:22,y:38,w:10,h:30},{x:48,y:32,w:11,h:34},{x:72,y:42,w:9,h:28}].map((p,i)=>(
              <div key={i} style={{position:'absolute',left:`${p.x}%`,top:`${p.y+p.h*0.45}%`,width:`${p.w}%`,height:`${p.h*0.55}%`,background:'linear-gradient(180deg, rgba(60,60,50,0.55), rgba(30,30,25,0.7))',borderRadius:'8px 8px 2px 2px'}}/>
            ))}
          </div>
          <div className="cam-meta" style={{ padding: '10px 14px' }}>
            <div className="flex items-center gap-3">
              <UI.StatusPill status={cam.status} />
              <span className="text-xs text-dim mono">rtsp://…/{cam.id.toLowerCase()}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-dim">Detections last 10m: <span className="mono" style={{ color: 'var(--text)' }}>47</span></span>
              <span className="text-xs text-dim">· Known <span className="mono" style={{ color: 'var(--success-text)' }}>44</span> · Unknown <span className="mono" style={{ color: 'var(--warning-text)' }}>3</span></span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Cameras</h3>
            <button className="btn btn-sm btn-ghost"><Icon name="plus" size={12} /></button>
          </div>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {CAMERAS.map(c => (
              <div key={c.id} onClick={() => setActiveCam(c.id)} style={{
                padding: '8px 10px', borderRadius: 7, cursor: 'pointer',
                background: c.id === activeCam ? 'var(--bg-sunken)' : 'transparent',
                border: c.id === activeCam ? '1px solid var(--border)' : '1px solid transparent',
                display: 'flex', alignItems: 'center', gap: 10
              }}>
                <Icon name="camera" size={13} className={c.status === 'online' ? 'text-secondary' : 'text-dim'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500 }}>{c.name}</div>
                  <div className="text-xs text-dim mono">{c.id} · {c.fps.toFixed(1)} fps</div>
                </div>
                <UI.StatusPill status={c.status} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Event stream <Pill kind="accent" dot>live</Pill></h3>
          <div className="flex items-center gap-2">
            <button className="btn btn-sm btn-ghost"><Icon name="filter" size={12} />Only unknown</button>
            <button className="btn btn-sm"><Icon name="download" size={12} />Export last hour</button>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr><th>Time</th><th>Camera</th><th>Identified</th><th>Confidence</th><th>Evidence</th><th>Status</th></tr>
          </thead>
          <tbody>
            {LIVE_EVENTS.map((ev, i) => {
              const emp = ev.empId ? empById[ev.empId] : null;
              return (
                <tr key={i}>
                  <td className="mono text-sm">{ev.t}</td>
                  <td><span className="pill pill-neutral">{ev.cam}</span></td>
                  <td>{emp ? <UI.PersonCell person={emp} hideFaces={hideFaces} subtitle={emp.id} /> : (
                    <div className="flex items-center gap-2">
                      <div className="face-thumb" style={{ background: 'var(--warning-soft)', display: 'grid', placeItems: 'center', color: 'var(--warning-text)' }}>?</div>
                      <span className="text-secondary">Unknown face</span>
                    </div>
                  )}</td>
                  <td className="mono text-sm" style={{ color: ev.confidence > 0.7 ? 'var(--success-text)' : 'var(--warning-text)' }}>{(ev.confidence*100).toFixed(0)}%</td>
                  <td><div style={{ width: 60, height: 6, background: 'var(--bg-sunken)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${ev.confidence*100}%`, height: '100%', background: ev.confidence > 0.7 ? 'var(--success)' : 'var(--warning)' }} />
                  </div></td>
                  <td><UI.StatusPill status={ev.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function ApprovalsPage({ role, hideFaces, onOpenRequest }) {
  const { APPROVAL_REQUESTS, EMPLOYEES } = window.APP_DATA;
  const empById = Object.fromEntries(EMPLOYEES.map(e => [e.id, e]));
  const [filter, setFilter] = React.useState('all');
  let items = APPROVAL_REQUESTS;
  if (filter === 'pending') items = items.filter(r => r.status.startsWith('pending'));
  if (filter === 'approved') items = items.filter(r => r.status === 'approved');
  if (filter === 'rejected') items = items.filter(r => r.status === 'rejected');

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Approvals</h1>
          <p className="page-sub">Two-level sequential workflow · Manager → HR · {APPROVAL_REQUESTS.filter(r => r.status.startsWith('pending')).length} pending</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={12} />Export</button>
          <button className="btn btn-primary"><Icon name="plus" size={12} />New request</button>
        </div>
      </div>

      <div className="flex items-center justify-between mb-2" style={{ marginBottom: 16 }}>
        <div className="seg">
          {['all', 'pending', 'approved', 'rejected'].map(f => (
            <button key={f} className={`seg-btn ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f[0].toUpperCase() + f.slice(1)}</button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-sm btn-ghost"><Icon name="filter" size={12} />Department</button>
          <button className="btn btn-sm btn-ghost"><Icon name="calendar" size={12} />Date range</button>
        </div>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr><th>ID</th><th>Employee</th><th>Type</th><th>Date</th><th>Reason</th><th>Stage</th><th>Submitted</th><th></th></tr>
          </thead>
          <tbody>
            {items.map(r => {
              const e = empById[r.employee];
              return (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => onOpenRequest(r)}>
                  <td className="mono text-sm">{r.id}</td>
                  <td><UI.PersonCell person={e} hideFaces={hideFaces} subtitle={e.designation} /></td>
                  <td><Pill kind={r.type === 'Late-in' ? 'warning' : r.type === 'Early-out' ? 'info' : 'neutral'}>{r.type}</Pill></td>
                  <td className="mono text-sm">{r.date}</td>
                  <td className="text-sm" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.reason}</td>
                  <td><UI.StatusPill status={r.status} /></td>
                  <td className="mono text-xs text-dim">{r.submitted}</td>
                  <td style={{ textAlign: 'right' }}><Icon name="chevronRight" size={13} className="text-dim" /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RequestDrawer({ request, onClose, hideFaces }) {
  const { EMPLOYEES } = window.APP_DATA;
  const emp = EMPLOYEES.find(e => e.id === request.employee);
  const stages = [
    { name: 'Submitted', by: emp.name, at: request.submitted, state: 'done' },
    { name: 'Manager', by: emp.mgr ? EMPLOYEES.find(e => e.id === emp.mgr)?.name : 'Line manager', at: request.chain[0]?.at, state: request.chain[0] ? (request.chain[0].decision === 'approved' ? 'done' : 'rejected') : (request.status === 'pending-mgr' ? 'active' : 'done') },
    { name: 'HR', by: 'HR Approver', at: request.chain[1]?.at, state: request.chain[1] ? (request.chain[1].decision === 'approved' ? 'done' : 'rejected') : (request.status === 'pending-hr' ? 'active' : request.status === 'approved' ? 'done' : 'pending') },
  ];
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="flex items-center gap-2">
              <span className="mono text-xs text-dim">{request.id}</span>
              <UI.StatusPill status={request.status} />
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>{request.type} · {request.date}</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="drawer-body">
          <div className="card-body" style={{ padding: 0, marginBottom: 16 }}>
            <UI.PersonCell person={emp} hideFaces={hideFaces} subtitle={emp.designation + ' · ' + emp.id} />
          </div>

          <div className="mb-2" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginTop: 18 }}>Approval chain</div>
          <div className="chain">
            {stages.map((s, i) => (
              <React.Fragment key={i}>
                <div className={`chain-step ${s.state}`}>
                  <div className="chain-dot">{s.state === 'done' ? <Icon name="check" size={14} /> : s.state === 'rejected' ? <Icon name="x" size={14} /> : i + 1}</div>
                  <div className="chain-step-name">{s.name}</div>
                  <div className="chain-step-sub">{s.by}</div>
                  {s.at && <div className="chain-step-sub">{s.at}</div>}
                </div>
                {i < stages.length - 1 && <div className="chain-bar" />}
              </React.Fragment>
            ))}
          </div>

          <div className="hr" />

          <div className="mb-2" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)' }}>Request details</div>
          <div className="grid grid-2" style={{ gap: 10, marginBottom: 14 }}>
            <div>
              <div className="text-xs text-dim">Reason</div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{request.reason}</div>
            </div>
            <div>
              <div className="text-xs text-dim">Attachment</div>
              <div style={{ fontSize: 13 }}>{request.attachment ? <span className="flex items-center gap-2"><Icon name="fileText" size={12} />{request.attachment}</span> : <span className="text-dim">None</span>}</div>
            </div>
          </div>
          <div style={{ padding: 12, background: 'var(--bg-sunken)', borderRadius: 8, fontSize: 13, lineHeight: 1.5 }}>
            {request.notes}
          </div>

          {request.chain.length > 0 && (
            <>
              <div className="mb-2" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginTop: 20 }}>Decisions</div>
              {request.chain.map((c, i) => (
                <div key={i} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, marginBottom: 8 }}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <UI.StatusPill status={c.decision === 'approved' ? 'approved' : 'rejected'} />
                      <span style={{ fontSize: 12.5, fontWeight: 500 }}>{c.by}</span>
                    </div>
                    <span className="mono text-xs text-dim">{c.at}</span>
                  </div>
                  <div className="text-sm text-secondary">{c.note}</div>
                </div>
              ))}
            </>
          )}

          <div className="mb-2" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginTop: 20 }}>Add decision note</div>
          <textarea className="textarea" placeholder="Optional note to requester…" />
        </div>
        <div className="drawer-foot">
          <button className="btn"><Icon name="x" size={12} />Reject</button>
          <button className="btn btn-accent"><Icon name="check" size={12} />Approve</button>
        </div>
      </div>
    </>
  );
}

function RecordDrawer({ record, onClose, hideFaces }) {
  const { person, day } = record;
  const events = [
    { t: '07:28:42', cam: 'CAM-01', conf: 0.97 },
    { t: '08:12:04', cam: 'CAM-08', conf: 0.94 },
    { t: '12:05:11', cam: 'CAM-08', conf: 0.96 },
    { t: '12:58:33', cam: 'CAM-08', conf: 0.93 },
    { t: '15:34:12', cam: 'CAM-02', conf: 0.95 },
  ];
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-head">
          <div>
            <div className="mono text-xs text-dim">Attendance record</div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 2 }}>{person.name} · {day ? day.date.toDateString() : 'Today'}</div>
          </div>
          <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="drawer-body">
          <div className="flex items-center gap-3 mb-2" style={{ marginBottom: 16 }}>
            <UI.FaceThumb person={person} size="xl" hideFaces={hideFaces} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{person.name}</div>
              <div className="text-sm text-dim mono">{person.id} · {person.designation}</div>
              <div className="flex gap-2 mt-2">
                <Pill kind="accent">{person.policy}</Pill>
                <UI.StatusPill status="present" />
              </div>
            </div>
          </div>

          <div className="grid grid-4" style={{ gap: 10, marginBottom: 16 }}>
            {[
              { label: 'In time', value: '07:28:42' },
              { label: 'Out time', value: '15:34:12' },
              { label: 'Total', value: '08:05:30' },
              { label: 'Overtime', value: '+0.1h' },
            ].map(s => (
              <div key={s.label} style={{ padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 8 }}>
                <div className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>{s.label}</div>
                <div className="mono" style={{ fontSize: 15, fontWeight: 500, marginTop: 2 }}>{s.value}</div>
              </div>
            ))}
          </div>

          <div className="mb-2" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)' }}>Day timeline</div>
          <UI.DayRuler policy={{ in: 7.5, out: 15.5 }} session={{ in: 7.48, out: 15.57 }} events={events.map(e => parseTimeH(e.t))} />

          <div className="mb-2" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginTop: 20 }}>Evidence · 5 face crops</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
            {events.map((ev, i) => (
              <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ aspectRatio: '1', background: `radial-gradient(circle at 40% 40%, ${person.avatar}, oklch(0.3 0.05 240))`, position: 'relative' }}>
                  {!hideFaces && (
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '45%', background: 'linear-gradient(180deg, transparent, rgba(0,0,0,0.6))' }} />
                  )}
                  {hideFaces && (
                    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'white', fontSize: 14, fontWeight: 600 }}>{person.initials}</div>
                  )}
                  <div style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(0,0,0,0.6)', color: 'white', fontSize: 9, padding: '1px 4px', borderRadius: 3, fontFamily: 'var(--font-mono)' }}>
                    {(ev.conf * 100).toFixed(0)}%
                  </div>
                </div>
                <div style={{ padding: '4px 6px' }}>
                  <div className="mono text-xs" style={{ fontSize: 10 }}>{ev.t.slice(0, 5)}</div>
                  <div className="text-xs text-dim" style={{ fontSize: 9.5 }}>{ev.cam}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="mb-2" style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginTop: 20 }}>Policy applied</div>
          <div style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
            <div className="flex items-center justify-between">
              <div style={{ fontSize: 13, fontWeight: 500 }}>{person.policy}</div>
              <span className="text-xs text-dim mono">assigned · dept-level</span>
            </div>
            <div className="text-sm text-dim" style={{ marginTop: 4 }}>Must complete 8 hours. Window opens 07:30, closes 16:30.</div>
          </div>
        </div>
        <div className="drawer-foot">
          <button className="btn"><Icon name="download" size={12} />Export</button>
          <button className="btn btn-primary"><Icon name="plus" size={12} />Submit exception</button>
        </div>
      </div>
    </>
  );
}

function PoliciesPage({ hideFaces }) {
  const { SHIFT_POLICIES } = window.APP_DATA;
  const [selected, setSelected] = React.useState(SHIFT_POLICIES[0].id);
  const policy = SHIFT_POLICIES.find(p => p.id === selected);
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Shift policies</h1>
          <p className="page-sub">Fixed, Flex, Ramadan and custom · assign per dept, employee, or globally</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="upload" size={12} />Import</button>
          <button className="btn btn-primary"><Icon name="plus" size={12} />New policy</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1.6fr' }}>
        <div className="card">
          <div className="card-head"><h3 className="card-title">Policies</h3></div>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {SHIFT_POLICIES.map(p => (
              <div key={p.id} onClick={() => setSelected(p.id)} style={{
                padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
                background: p.id === selected ? 'var(--bg-sunken)' : 'transparent',
                border: p.id === selected ? '1px solid var(--border)' : '1px solid transparent',
              }}>
                <div className="flex items-center justify-between">
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</div>
                  <Pill kind={p.active ? 'success' : 'neutral'} dot>{p.active ? 'Active' : 'Off'}</Pill>
                </div>
                <div className="text-xs text-dim" style={{ marginTop: 3, fontFamily: 'var(--font-mono)' }}>
                  {p.type} · {p.in} → {p.out} · {p.assigned} assigned
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">{policy.name} <Pill kind="accent">{policy.type}</Pill></h3>
              <p className="card-sub">{policy.description}{policy.window ? ` · ${policy.window}` : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <button className="btn btn-sm"><Icon name="edit" size={12} />Edit</button>
              <button className="btn btn-sm btn-ghost"><Icon name="more" size={13} /></button>
            </div>
          </div>
          <div className="card-body">
            <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginBottom: 8 }}>Shift window</div>
            <ShiftTimeline policy={policy} />

            <div className="grid grid-2" style={{ gap: 12, marginTop: 16 }}>
              <div className="field">
                <label className="field-label">In time</label>
                <input className="input mono" defaultValue={policy.in} />
                {policy.type === 'Flex' && <span className="field-help">Flex range · earliest – latest acceptable</span>}
              </div>
              <div className="field">
                <label className="field-label">Out time</label>
                <input className="input mono" defaultValue={policy.out} />
              </div>
              <div className="field">
                <label className="field-label">Required hours</label>
                <input className="input mono" defaultValue={policy.hours} />
              </div>
              <div className="field">
                <label className="field-label">Overtime threshold</label>
                <input className="input mono" defaultValue="+15m" />
              </div>
            </div>

            <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginTop: 20, marginBottom: 8 }}>Flag rules</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[
                { k: 'late-in', label: 'Late in', cond: 'In > start time', act: 'Flag "Late Nm" · notify manager' },
                { k: 'early-out', label: 'Early out', cond: 'Out < end time', act: 'Flag "Early Nm" · notify manager' },
                { k: 'overtime', label: 'Overtime', cond: 'Total > required + threshold', act: 'Store OT · notify HR' },
                { k: 'absent', label: 'Absent', cond: 'No detection & not on leave/holiday', act: 'Flag "Absent" · include in daily report' },
              ].map(r => (
                <div key={r.k} style={{ padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, display: 'grid', gridTemplateColumns: '140px 1fr 1fr auto', gap: 10, alignItems: 'center' }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.label}</div>
                  <div className="text-xs text-dim mono">{r.cond}</div>
                  <div className="text-xs">{r.act}</div>
                  <Pill kind="success" dot>On</Pill>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ShiftTimeline({ policy }) {
  // Visual 06:00–18:00 (or full day for night) with policy window marked
  const nightShift = policy.type === 'Custom' && policy.in === '19:00';
  const range = nightShift ? { from: 17, to: 29 } : { from: 6, to: 18 }; // 29 = 05:00 next day
  const hours = Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i);
  const toPct = (h) => ((h - range.from) / (range.to - range.from)) * 100;
  const parseT = (s) => {
    const m = s.match(/(\d\d):(\d\d)/);
    return m ? parseInt(m[1]) + parseInt(m[2])/60 : 0;
  };
  const inVal = parseT(policy.in.split('–')[0] || policy.in);
  const outVal = policy.in.split('–')[1] ? parseT(policy.out.split('–')[1]) : parseT(policy.out);
  const inEnd = policy.in.includes('–') ? parseT(policy.in.split('–')[1]) : inVal;
  const outStart = policy.out.includes('–') ? parseT(policy.out.split('–')[0]) : outVal;
  const outAdj = outVal < inVal ? outVal + 24 : outVal;
  const outStartAdj = outStart < inVal ? outStart + 24 : outStart;

  return (
    <div style={{ position: 'relative', height: 70, background: 'var(--bg-sunken)', borderRadius: 10, border: '1px solid var(--border)' }}>
      {hours.map(h => {
        if ((h - range.from) % 2 !== 0) return null;
        const displayH = h % 24;
        return (
          <React.Fragment key={h}>
            <div style={{ position: 'absolute', left: `${toPct(h)}%`, top: 0, bottom: 0, width: 1, background: 'var(--border)' }} />
            <div style={{ position: 'absolute', left: `${toPct(h)}%`, bottom: 4, transform: 'translateX(-50%)', fontSize: 9.5, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              {displayH.toString().padStart(2,'0')}:00
            </div>
          </React.Fragment>
        );
      })}
      {/* Arrive zone (flex) */}
      {policy.in.includes('–') && (
        <div style={{ position: 'absolute', top: 12, height: 16, left: `${toPct(inVal)}%`, width: `${toPct(inEnd) - toPct(inVal)}%`, background: 'var(--accent-soft)', borderRadius: 4, border: '1px dashed var(--accent-border)' }}>
          <span style={{ fontSize: 9.5, color: 'var(--accent-text)', padding: '1px 4px', fontFamily: 'var(--font-mono)' }}>arrive</span>
        </div>
      )}
      {/* Work zone */}
      <div style={{ position: 'absolute', top: policy.in.includes('–') ? 32 : 16, height: 18, left: `${toPct(inVal)}%`, width: `${toPct(outAdj) - toPct(inVal)}%`, background: 'var(--accent)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
        {policy.hours}h work
      </div>
      {/* Depart zone (flex) */}
      {policy.out.includes('–') && (
        <div style={{ position: 'absolute', top: 12, height: 16, left: `${toPct(outStartAdj)}%`, width: `${toPct(outAdj) - toPct(outStartAdj)}%`, background: 'var(--accent-soft)', borderRadius: 4, border: '1px dashed var(--accent-border)' }}>
          <span style={{ fontSize: 9.5, color: 'var(--accent-text)', padding: '1px 4px', fontFamily: 'var(--font-mono)' }}>depart</span>
        </div>
      )}
    </div>
  );
}

function EnrollmentPage({ hideFaces }) {
  const { EMPLOYEES } = window.APP_DATA;
  const [tab, setTab] = React.useState('excel');
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Employee enrollment</h1>
          <p className="page-sub">Import employees via Excel · ingest reference photos by filename</p>
        </div>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'excel' ? 'active' : ''}`} onClick={() => setTab('excel')}>Excel import</button>
        <button className={`tab ${tab === 'photos' ? 'active' : ''}`} onClick={() => setTab('photos')}>Reference photos</button>
        <button className={`tab ${tab === 'orphans' ? 'active' : ''}`} onClick={() => setTab('orphans')}>Orphans <span className="nav-badge" style={{ marginInlineStart: 6 }}>3</span></button>
      </div>

      {tab === 'excel' && (
        <div className="grid" style={{ gridTemplateColumns: '1fr 1.3fr' }}>
          <div className="card">
            <div className="card-head"><h3 className="card-title">Upload Excel (.xlsx)</h3></div>
            <div className="card-body">
              <div className="dropzone">
                <Icon name="excel" size={24} />
                <div style={{ marginTop: 8 }}><strong>Drop your .xlsx file</strong> or click to browse</div>
                <div className="text-xs text-dim mt-2">Required columns: Employee ID, Name, Email, Department(s), Designation, Role, Manager Email</div>
                <button className="btn btn-primary mt-4" style={{ marginTop: 12 }}>Choose file</button>
              </div>
              <div className="text-xs text-dim mt-4" style={{ marginTop: 14 }}>
                <div>· Duplicate IDs are rejected</div>
                <div>· Emails must be unique</div>
                <div>· System shows a dry-run preview before commit</div>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Dry-run preview · <span className="text-dim">omran-employees-apr.xlsx</span></h3>
              <div className="flex gap-2">
                <Pill kind="success">14 new</Pill>
                <Pill kind="info">7 update</Pill>
                <Pill kind="danger">2 reject</Pill>
              </div>
            </div>
            <table className="table table-compact">
              <thead><tr><th>ID</th><th>Name</th><th>Department</th><th>Role</th><th>Action</th></tr></thead>
              <tbody>
                {EMPLOYEES.slice(0, 8).map((e, i) => (
                  <tr key={e.id}>
                    <td className="mono text-xs">{e.id}</td>
                    <td className="text-sm">{e.name}</td>
                    <td className="text-xs text-dim">{e.dept.toUpperCase()}</td>
                    <td><Pill kind="neutral">{e.role}</Pill></td>
                    <td>{i < 2 ? <Pill kind="info">update</Pill> : i === 7 ? <Pill kind="danger">dup email</Pill> : <Pill kind="success">new</Pill>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="card-body" style={{ borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn">Cancel</button>
              <button className="btn btn-accent"><Icon name="check" size={12} />Commit import</button>
            </div>
          </div>
        </div>
      )}

      {tab === 'photos' && (
        <div className="grid" style={{ gridTemplateColumns: '1fr 1.3fr' }}>
          <div className="card">
            <div className="card-head"><h3 className="card-title">Upload reference photos</h3></div>
            <div className="card-body">
              <div className="dropzone">
                <Icon name="upload" size={22} />
                <div style={{ marginTop: 8 }}><strong>Drop images</strong> to ingest</div>
                <div className="text-xs text-dim mt-2">Filename stem = Employee ID. e.g. <span className="mono">OM0097.jpg</span>, <span className="mono">OM0097_left.jpg</span></div>
                <button className="btn btn-primary" style={{ marginTop: 12 }}>Choose files</button>
              </div>
              <hr className="hr" />
              <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)', marginBottom: 10 }}>Re-run identification</div>
              <div className="text-sm text-secondary">Process previously-unknown events against new photos.</div>
              <button className="btn mt-3" style={{ marginTop: 10 }}><Icon name="refresh" size={12} />Re-run now</button>
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Enrolled employees · photos</h3>
              <div className="text-xs text-dim">{EMPLOYEES.length} people · <span className="mono">97%</span> with ≥1 reference photo</div>
            </div>
            <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
              {EMPLOYEES.slice(0, 12).map(e => (
                <div key={e.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, textAlign: 'center' }}>
                  <UI.FaceThumb person={e} size="xl" hideFaces={hideFaces} />
                  <div style={{ fontSize: 12, fontWeight: 500, marginTop: 6 }}>{e.name}</div>
                  <div className="mono text-xs text-dim">{e.id} · {Math.floor(Math.random()*3)+1} photos</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'orphans' && (
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Orphan photos <Pill kind="warning">3</Pill></h3>
            <p className="card-sub">Filename didn't match any employee record. Create employee or rename file.</p>
          </div>
          <table className="table">
            <thead><tr><th>File</th><th>Uploaded</th><th>Extracted ID</th><th>Suggested match</th><th></th></tr></thead>
            <tbody>
              {[
                { f: 'OM0999.jpg', at: '2026-04-22 14:12', id: 'OM0999', match: null },
                { f: 'om-new-hire.jpg', at: '2026-04-22 11:48', id: 'om-new-hire', match: null },
                { f: 'OM0045_right.jpg', at: '2026-04-21 09:22', id: 'OM0045', match: 'Fatima Al-Kindi (add as angle)' },
              ].map(r => (
                <tr key={r.f}>
                  <td className="mono text-sm">{r.f}</td>
                  <td className="mono text-xs text-dim">{r.at}</td>
                  <td className="mono text-sm">{r.id}</td>
                  <td className="text-sm">{r.match || <span className="text-dim">— none —</span>}</td>
                  <td><div className="flex gap-2"><button className="btn btn-sm">Create employee</button><button className="btn btn-sm btn-ghost"><Icon name="trash" size={12} /></button></div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ReportsPage({ onNewReport }) {
  const { REPORT_SCHEDULES } = window.APP_DATA;
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <p className="page-sub">Daily attendance, department summary, event log · on-demand & scheduled</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={12} />On-demand export</button>
          <button className="btn btn-primary" onClick={onNewReport}><Icon name="plus" size={12} />New report</button>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        {[
          { name: 'Daily Attendance', sub: 'one row per person per day', cols: 12, icon: 'calendar' },
          { name: 'Event Log', sub: 'one row per detected appearance', cols: 6, icon: 'activity' },
          { name: 'Department Summary', sub: 'aggregated counts per dept', cols: 8, icon: 'building' },
        ].map(r => (
          <div key={r.name} className="card" style={{ padding: 16 }}>
            <div className="flex items-center justify-between mb-2">
              <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-text)', display: 'grid', placeItems: 'center' }}>
                <Icon name={r.icon} size={15} />
              </div>
              <button className="btn btn-sm btn-ghost"><Icon name="more" size={14} /></button>
            </div>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 10 }}>{r.name}</div>
            <div className="text-sm text-dim">{r.sub}</div>
            <div className="text-xs text-dim mono mt-3" style={{ marginTop: 10 }}>{r.cols} columns · xlsx / pdf</div>
            <div className="flex gap-2 mt-3" style={{ marginTop: 12 }}>
              <button className="btn btn-sm">Preview</button>
              <button className="btn btn-sm btn-primary">Run now</button>
            </div>
          </div>
        ))}
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

function EmployeesPage({ hideFaces, onOpenRecord }) {
  const { EMPLOYEES, DEPARTMENTS } = window.APP_DATA;
  const deptById = Object.fromEntries(DEPARTMENTS.map(d => [d.id, d]));
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Employees</h1>
          <p className="page-sub">{EMPLOYEES.length} people · <span className="mono">97%</span> fully enrolled with reference photos</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={12} />Export</button>
          <button className="btn btn-primary"><Icon name="upload" size={12} />Import</button>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h3 className="card-title">All employees</h3>
          <div className="flex gap-2">
            <button className="btn btn-sm btn-ghost"><Icon name="filter" size={12} />Department</button>
            <button className="btn btn-sm btn-ghost"><Icon name="filter" size={12} />Role</button>
          </div>
        </div>
        <table className="table">
          <thead><tr><th>Employee</th><th>ID</th><th>Department</th><th>Role</th><th>Policy</th><th>Manager</th><th>Photos</th></tr></thead>
          <tbody>
            {EMPLOYEES.map(e => (
              <tr key={e.id} onClick={() => onOpenRecord(e)} style={{ cursor: 'pointer' }}>
                <td><UI.PersonCell person={e} hideFaces={hideFaces} subtitle={e.designation} /></td>
                <td className="mono text-sm">{e.id}</td>
                <td className="text-sm">{deptById[e.dept].name}</td>
                <td><Pill kind={e.role === 'Admin' ? 'accent' : e.role === 'HR' ? 'info' : e.role === 'Manager' ? 'warning' : 'neutral'}>{e.role}</Pill></td>
                <td className="text-sm"><span className="pill pill-neutral">{e.policy}</span></td>
                <td className="text-sm">{e.mgr ? EMPLOYEES.find(x => x.id === e.mgr)?.name.split(' ')[0] : <span className="text-dim">—</span>}</td>
                <td><div className="flex gap-2"><Pill kind="success">{Math.floor(Math.random()*3)+1}</Pill></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

window.Pages = { LiveCapture, ApprovalsPage, RequestDrawer, RecordDrawer, PoliciesPage, EnrollmentPage, ReportsPage, EmployeesPage };
