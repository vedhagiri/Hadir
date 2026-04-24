/* Page: HR Dashboard (primary, deepest) + Admin, Manager, Employee dashboards */

function HRDashboard({ hideFaces, onOpenRequest, onOpenRecord }) {
  const { EMPLOYEES, APPROVAL_REQUESTS, DEPARTMENTS } = window.APP_DATA;
  const empById = Object.fromEntries(EMPLOYEES.map(e => [e.id, e]));
  const pending = APPROVAL_REQUESTS.filter(r => r.status.startsWith('pending'));
  const last14 = Array.from({ length: 14 }, (_, i) => ({
    label: i % 3 === 0 ? `${10 + i}` : '',
    value: 90 + Math.round(Math.sin(i / 2) * 4 + (i % 3) * 1.8),
    value2: 96 - (i % 4 === 0 ? 3 : 0),
  }));

  const heatmap = Array.from({ length: 7 }, (_, r) =>
    Array.from({ length: 24 }, (_, c) => {
      if (r === 5 || r === 6) return 0.02;
      if (c < 6 || c > 19) return c === 7 ? 0.15 : 0.02;
      if (c === 7 || c === 8) return 0.95;
      if (c === 15 || c === 16) return 0.75;
      return 0.35 + Math.random() * 0.25;
    })
  );

  const deptData = DEPARTMENTS.map((d, i) => ({
    label: d.name.slice(0, 3).toUpperCase(),
    present: 90 - (i === 3 ? 8 : 0) - (i === 5 ? 5 : 0),
    late: 5 + (i === 3 ? 4 : 0),
    absent: 2 + (i === 5 ? 4 : 0),
  }));

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Good morning, Aisha</h1>
          <p className="page-sub">Thursday, 23 April 2026 · Ramadan ended 2 days ago · <span className="mono">94.2%</span> presence company-wide today</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="download" size={12} />Export today</button>
          <button className="btn"><Icon name="calendar" size={12} />Apr 23, 2026</button>
          <button className="btn btn-primary"><Icon name="send" size={12} />Send daily report</button>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <UI.StatCard label="Present today" value="98" delta="+3" deltaLabel="vs yesterday" tone="up" spark={[82,84,86,88,89,91,95,98]} icon="users" />
        <UI.StatCard label="Late arrivals" value="7" delta="−2" deltaLabel="vs 7-day avg" tone="up" spark={[12,10,11,9,8,8,9,7]} icon="clock" />
        <UI.StatCard label="Pending approvals" value="4" delta="2 with HR" deltaLabel="2 with mgrs" tone="flat" icon="inbox" />
        <UI.StatCard label="Identification rate" value="97.3%" delta="+0.4%" deltaLabel="7-day trend" tone="up" spark={[95,95,96,96,97,97,97,98]} icon="zap" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Company-wide presence <Pill kind="accent">14 days</Pill></h3>
              <p className="card-sub">Daily identified-presence rate against policy window</p>
            </div>
            <div className="seg">
              <button className="seg-btn">7d</button>
              <button className="seg-btn active">14d</button>
              <button className="seg-btn">30d</button>
              <button className="seg-btn">90d</button>
            </div>
          </div>
          <div className="card-body">
            <UI.LineChart data={last14} height={180} />
            <div className="flex items-center gap-4" style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-secondary)' }}>
              <span className="flex items-center gap-2"><span style={{ width: 10, height: 2, background: 'var(--accent)', borderRadius: 2 }} />Presence %</span>
              <span className="flex items-center gap-2"><span style={{ width: 10, height: 2, background: 'var(--text-tertiary)', borderRadius: 2 }} />Target 96%</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Status breakdown</h3>
            <span className="text-xs text-dim mono">Apr 23</span>
          </div>
          <div className="card-body flex items-center gap-4">
            <UI.Donut parts={[
              { label: 'Present', value: 91, color: 'var(--accent)' },
              { label: 'Late', value: 7, color: 'var(--warning)' },
              { label: 'On leave', value: 4, color: 'var(--info)' },
              { label: 'Absent', value: 4, color: 'var(--danger)' },
            ]} size={130} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
              {[
                { label: 'Present', value: 91, color: 'var(--accent)' },
                { label: 'Late', value: 7, color: 'var(--warning)' },
                { label: 'On leave', value: 4, color: 'var(--info)' },
                { label: 'Absent', value: 4, color: 'var(--danger)' },
              ].map(p => (
                <div key={p.label} className="flex items-center gap-2" style={{ fontSize: 12 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
                  <span style={{ flex: 1 }}>{p.label}</span>
                  <span className="mono text-dim">{p.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Arrival density · last 7 days</h3>
              <p className="card-sub">Hours (00–23) × weekday · identified check-ins</p>
            </div>
          </div>
          <div className="card-body">
            <UI.Heatmap data={heatmap} />
            <div className="flex items-center justify-between" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-tertiary)' }}>
              <span>Peak: Sun–Thu 07:30–08:00</span>
              <div className="flex items-center gap-2">
                <span>Less</span>
                {[0.1, 0.3, 0.5, 0.7, 0.95].map(v => (
                  <span key={v} style={{ width: 10, height: 10, borderRadius: 2, background: `oklch(0.58 0.1 195 / ${0.15 + v * 0.85})` }} />
                ))}
                <span>More</span>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">By department · today</h3>
              <p className="card-sub">Present / late / absent stack</p>
            </div>
            <button className="btn btn-sm btn-ghost"><Icon name="more" size={14} /></button>
          </div>
          <div className="card-body">
            <UI.StackedBars data={deptData} />
            <div className="flex items-center gap-4" style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
              <span className="flex items-center gap-2"><span style={{ width: 10, height: 8, background: 'var(--accent)', borderRadius: 2 }} />Present</span>
              <span className="flex items-center gap-2"><span style={{ width: 10, height: 8, background: 'var(--warning)', borderRadius: 2 }} />Late</span>
              <span className="flex items-center gap-2"><span style={{ width: 10, height: 8, background: 'var(--danger)', borderRadius: 2 }} />Absent</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.3fr 1fr', marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Approval queue <Pill kind="warning">{pending.length} pending</Pill></h3>
              <p className="card-sub">HR-level final approvals appear here</p>
            </div>
            <button className="btn btn-sm">See all</button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Type</th>
                <th>Date</th>
                <th>Stage</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pending.slice(0, 5).map(r => {
                const e = empById[r.employee];
                return (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => onOpenRequest(r)}>
                    <td><UI.PersonCell person={e} hideFaces={hideFaces} subtitle={r.reason} /></td>
                    <td>{r.type}</td>
                    <td className="mono text-sm">{r.date}</td>
                    <td><UI.StatusPill status={r.status} /></td>
                    <td style={{ textAlign: 'right' }}>
                      <Icon name="chevronRight" size={14} className="text-dim" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Scheduled reports</h3>
              <p className="card-sub">Next delivery & last run</p>
            </div>
            <button className="btn btn-sm"><Icon name="plus" size={11} />New</button>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {window.APP_DATA.REPORT_SCHEDULES.map((s, i) => (
              <div key={s.id} style={{ padding: '10px 16px', borderBottom: i < window.APP_DATA.REPORT_SCHEDULES.length - 1 ? '1px solid var(--border)' : 0 }}>
                <div className="flex items-center justify-between">
                  <div style={{ fontSize: 12.5, fontWeight: 500 }}>{s.name}</div>
                  <UI.StatusPill status={s.status} />
                </div>
                <div className="flex items-center gap-3" style={{ marginTop: 3, fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  <span>{s.schedule}</span>
                  <span>·</span>
                  <span>{s.method}</span>
                </div>
                <div className="flex items-center gap-2" style={{ marginTop: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
                  <Icon name="mail" size={11} />
                  <span>{s.recipients.join(', ')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h3 className="card-title">Today's attendance · live</h3>
            <p className="card-sub">All identified employees · click any row to view evidence</p>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-sm btn-ghost"><Icon name="filter" size={12} />Filter</button>
            <button className="btn btn-sm"><Icon name="download" size={12} />Export</button>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Dept.</th>
              <th>Policy</th>
              <th>In</th>
              <th>Out</th>
              <th>Hours</th>
              <th>Flags</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {EMPLOYEES.slice(0, 9).map((e, i) => {
              const times = [
                { in: '07:28:42', out: '15:34:12', h: '08:05', flags: [], status: 'present' },
                { in: '08:12:05', out: '—', h: '—', flags: ['Late 42m'], status: 'late' },
                { in: '07:31:20', out: '15:32:18', h: '08:01', flags: [], status: 'present' },
                { in: '07:55:30', out: '16:42:07', h: '08:47', flags: ['+0.8h OT'], status: 'present' },
                { in: '07:29:11', out: '—', h: '—', flags: [], status: 'present' },
                { in: '—', out: '—', h: '—', flags: ['Annual leave'], status: 'leave' },
                { in: '07:33:58', out: '15:31:02', h: '07:57', flags: [], status: 'present' },
                { in: '08:45:22', out: '—', h: '—', flags: ['Late 75m', 'Request pending'], status: 'pending-mgr' },
                { in: '07:27:09', out: '—', h: '—', flags: [], status: 'present' },
              ][i];
              return (
                <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => onOpenRecord(e)}>
                  <td><UI.PersonCell person={e} hideFaces={hideFaces} subtitle={e.designation} /></td>
                  <td className="text-sm">{window.APP_DATA.DEPARTMENTS.find(d => d.id === e.dept).name}</td>
                  <td><span className="pill pill-neutral">{e.policy}</span></td>
                  <td className="mono text-sm">{times.in}</td>
                  <td className="mono text-sm">{times.out}</td>
                  <td className="mono text-sm">{times.h}</td>
                  <td>
                    <div className="flex gap-2">
                      {times.flags.map((f, j) => (
                        <span key={j} className={`pill ${f.includes('Late') ? 'pill-warning' : f.includes('OT') ? 'pill-accent' : f.includes('pending') ? 'pill-info' : 'pill-info'}`}>{f}</span>
                      ))}
                    </div>
                  </td>
                  <td><UI.StatusPill status={times.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AdminDashboard({ hideFaces }) {
  const { CAMERAS } = window.APP_DATA;
  const online = CAMERAS.filter(c => c.status === 'online').length;
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">System health</h1>
          <p className="page-sub">Omran HQ · 6 sites · 1 Ubuntu host · <span className="mono">uptime 42d 18h</span></p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="refresh" size={12} />Refresh all</button>
          <button className="btn btn-primary"><Icon name="plus" size={12} />Add camera</button>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <UI.StatCard label="Cameras online" value={`${online}/${CAMERAS.length}`} delta="1 offline · 1 degraded" tone="flat" spark={[8,8,7,8,7,7,6,7]} icon="camera" />
        <UI.StatCard label="Events today" value="4,827" delta="+612" deltaLabel="vs 7d avg" tone="up" spark={[3200,3400,3800,4100,4300,4500,4600,4827]} icon="activity" />
        <UI.StatCard label="Identification rate" value="97.3%" delta="+0.4%" tone="up" spark={[95,96,96,97,97,97,97,97]} icon="zap" />
        <UI.StatCard label="Disk usage" value="62%" delta="18% free" deltaLabel="· rotating" tone="flat" icon="hardDrive" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h3 className="card-title">Camera fleet</h3>
            <div className="seg">
              <button className="seg-btn active">All</button>
              <button className="seg-btn">Entry</button>
              <button className="seg-btn">Exit</button>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Camera</th>
                <th>Location</th>
                <th>Zone</th>
                <th>FPS</th>
                <th>Uptime</th>
                <th>Events</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {CAMERAS.map(c => (
                <tr key={c.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <div style={{ width: 26, height: 26, borderRadius: 6, background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center', color: c.status === 'online' ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                        <Icon name="camera" size={13} />
                      </div>
                      <div>
                        <div style={{ fontSize: 12.5, fontWeight: 500 }}>{c.name}</div>
                        <div className="mono text-xs text-dim">{c.id}</div>
                      </div>
                    </div>
                  </td>
                  <td className="text-sm">{c.location}</td>
                  <td><Pill kind={c.zone === 'entry' ? 'accent' : 'neutral'}>{c.zone}</Pill></td>
                  <td className="mono text-sm">{c.fps.toFixed(1)}</td>
                  <td className="mono text-sm">{c.uptime.toFixed(1)}%</td>
                  <td className="mono text-sm">{c.events}</td>
                  <td><UI.StatusPill status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">System signals</h3>
          </div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[
              { icon: 'database', label: 'PostgreSQL', sub: 'primary · 3.2 GB', status: 'ok' },
              { icon: 'hardDrive', label: 'Face crops storage', sub: '48.4 GB / 512 GB · 62% used', status: 'ok' },
              { icon: 'shield', label: 'Entra ID OIDC', sub: 'tenant · omran.onmicrosoft.com', status: 'ok' },
              { icon: 'mail', label: 'SMTP relay', sub: 'last send · 2 min ago', status: 'ok' },
              { icon: 'alert', label: 'CAM-06 offline', sub: 'warehouse back gate · 38 min', status: 'retry' },
              { icon: 'refresh', label: 'Daily backup', sub: 'last · 02:00 · 1.1 GB', status: 'ok' },
            ].map((r, i) => (
              <div key={i} className="flex items-center gap-3">
                <div style={{ width: 30, height: 30, borderRadius: 7, background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center', color: 'var(--text-secondary)' }}>
                  <Icon name={r.icon} size={14} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500 }}>{r.label}</div>
                  <div className="text-xs text-dim mono">{r.sub}</div>
                </div>
                <UI.StatusPill status={r.status} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function ManagerDashboard({ hideFaces, onOpenRecord }) {
  const { EMPLOYEES } = window.APP_DATA;
  const team = EMPLOYEES.filter(e => e.dept === 'ops');
  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Operations team · today</h1>
          <p className="page-sub">Sultan Al-Busaidi · {team.length} direct & matrix reports · <span className="mono">92.8%</span> presence</p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="mail" size={12} />Notify late</button>
          <button className="btn btn-primary"><Icon name="send" size={12} />Team summary</button>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <UI.StatCard label="On site now" value="24 / 28" delta="+2 vs yesterday" tone="up" icon="users" />
        <UI.StatCard label="Late today" value="2" delta="Fatima, Omar" tone="flat" icon="clock" />
        <UI.StatCard label="Awaiting my approval" value="2" delta="oldest 2 hours" tone="flat" icon="inbox" />
        <UI.StatCard label="Team OT this week" value="18.4h" delta="+2.1h" tone="up" icon="zap" />
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="card-title">Team roster · today</h3>
          <div className="seg">
            <button className="seg-btn active">All</button>
            <button className="seg-btn">Present</button>
            <button className="seg-btn">Late</button>
            <button className="seg-btn">Out</button>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Policy</th>
              <th>In</th>
              <th>Out</th>
              <th>Day timeline</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {team.map((e, i) => {
              const sample = [
                { in: '07:28', out: '—', inH: 7.48, outH: null, status: 'present', events: [7.48, 12.1, 13.2] },
                { in: '08:12', out: '—', inH: 8.2, outH: null, status: 'late', events: [8.2, 12.3] },
                { in: '07:31', out: '—', inH: 7.52, outH: null, status: 'present', events: [7.52, 12.5, 15.3] },
              ][i % 3];
              return (
                <tr key={e.id} onClick={() => onOpenRecord(e)} style={{ cursor: 'pointer' }}>
                  <td><UI.PersonCell person={e} hideFaces={hideFaces} subtitle={e.designation} /></td>
                  <td><span className="pill pill-neutral">{e.policy}</span></td>
                  <td className="mono text-sm">{sample.in}</td>
                  <td className="mono text-sm">{sample.out}</td>
                  <td style={{ minWidth: 240 }}>
                    <UI.DayRuler policy={{ in: 7.5, out: 15.5 }} session={{ in: sample.inH, out: sample.outH || 15.5 }} events={sample.events} />
                  </td>
                  <td><UI.StatusPill status={sample.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

window.Dashboards = { HRDashboard, AdminDashboard, ManagerDashboard };
