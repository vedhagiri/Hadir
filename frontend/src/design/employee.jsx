/* Employee-facing pages: own attendance with calendar + day detail.
   This includes the signature gorgeous calendar/timeline. */

function EmployeeDashboard({ hideFaces, onOpenRecord }) {
  const { EMPLOYEES, genAttendance } = window.APP_DATA;
  const me = EMPLOYEES.find(e => e.id === 'OM0045');
  const history = React.useMemo(() => genAttendance(42), []);
  const today = history[history.length - 1];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Mabrook, Fatima</h1>
          <p className="page-sub">Today's attendance · Operations · Policy <span className="mono">Flex 07:30–16:30</span></p>
        </div>
        <div className="page-actions">
          <button className="btn"><Icon name="upload" size={12} />Update photo</button>
          <button className="btn btn-primary"><Icon name="plus" size={12} />Submit request</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.3fr 1fr', marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h3 className="card-title">Today · Thursday 23 April 2026</h3>
              <p className="card-sub">Identified across 2 cameras · 4 events</p>
            </div>
            <UI.StatusPill status="present" />
          </div>
          <div className="card-body">
            <div className="grid grid-4" style={{ gap: 10, marginBottom: 14 }}>
              {[
                { label: 'In time', value: '07:28:42', sub: 'CAM-01 · Lobby' },
                { label: 'Out time', value: '—', sub: 'still on site' },
                { label: 'Total', value: '01:19', sub: 'since in' },
                { label: 'OT this month', value: '3.2h', sub: 'rolling' },
              ].map((s, i) => (
                <div key={i} style={{ padding: '10px 12px', background: 'var(--bg-sunken)', borderRadius: 8 }}>
                  <div className="text-xs text-dim" style={{ textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>{s.label}</div>
                  <div className="mono" style={{ fontSize: 16, fontWeight: 500, marginTop: 2 }}>{s.value}</div>
                  <div className="text-xs text-dim" style={{ marginTop: 1 }}>{s.sub}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>
              Day timeline
            </div>
            <UI.DayRuler policy={{ in: 7.5, out: 16.5 }} session={{ in: 7.48, out: 8.77 }} events={[7.48, 12.05, 12.58, 8.77]} />
            <div className="flex items-center gap-4" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)' }}>
              <span className="flex items-center gap-2"><span style={{ width: 12, height: 4, background: 'var(--accent-soft)', border: '1px dashed var(--accent-border)', display: 'inline-block' }} />Policy window</span>
              <span className="flex items-center gap-2"><span style={{ width: 12, height: 4, background: 'var(--accent)', borderRadius: 2 }} />On site</span>
              <span className="flex items-center gap-2"><span style={{ width: 2, height: 10, background: 'var(--text-secondary)' }} />Detection</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3 className="card-title">This month · at a glance</h3>
            <span className="text-xs text-dim mono">April</span>
          </div>
          <div className="card-body" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <UI.Donut parts={[
              { label: 'Present', value: 16, color: 'var(--accent)' },
              { label: 'Late', value: 2, color: 'var(--warning)' },
              { label: 'Leave', value: 1, color: 'var(--info)' },
              { label: 'Holiday', value: 3, color: 'var(--text-quaternary)' },
            ]} size={120} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[
                { label: 'Days present', value: '16', kind: 'accent' },
                { label: 'Late arrivals', value: '2', kind: 'warning' },
                { label: 'Leave taken', value: '1', kind: 'info' },
                { label: 'Overtime', value: '3.2h', kind: 'success' },
              ].map(r => (
                <div key={r.label} className="flex items-center justify-between" style={{ fontSize: 12 }}>
                  <span className="text-secondary">{r.label}</span>
                  <Pill kind={r.kind}>{r.value}</Pill>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <AttendanceCalendar history={history} onOpenRecord={(day) => onOpenRecord(me, day)} />
      <RequestHistory me={me} hideFaces={hideFaces} />
    </>
  );
}

function AttendanceCalendar({ history, onOpenRecord }) {
  // Signature: gorgeous calendar/timeline for the month.
  const [year, setYear] = React.useState(2026);
  const [month, setMonth] = React.useState(3); // April (0-indexed)
  const monthName = new Date(year, month, 1).toLocaleString('en', { month: 'long' });
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = first.getDay(); // 0=Sun
  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    const d = new Date(year, month, -startOffset + i + 1);
    cells.push({ date: d, otherMonth: true });
  }
  const byKey = Object.fromEntries(history.map(h => {
    const k = `${h.date.getFullYear()}-${h.date.getMonth()}-${h.date.getDate()}`;
    return [k, h];
  }));
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(year, month, i);
    const k = `${year}-${month}-${i}`;
    const h = byKey[k];
    cells.push({ date: d, rec: h });
  }
  while (cells.length % 7 !== 0) {
    const last = cells[cells.length - 1].date;
    const next = new Date(last);
    next.setDate(last.getDate() + 1);
    cells.push({ date: next, otherMonth: true });
  }

  const today = new Date(2026, 3, 23);
  const isToday = (d) => d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();

  // Compute left ruler hour distribution for timeline column
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h3 className="card-title">Attendance calendar <Pill kind="neutral">{monthName} {year}</Pill></h3>
          <p className="card-sub">Click any day to see evidence, hours and flags · color by status</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="icon-btn" onClick={() => setMonth(m => m === 0 ? (setYear(y => y-1), 11) : m - 1)}><Icon name="chevronLeft" size={13} /></button>
          <button className="btn btn-sm btn-ghost" onClick={() => { setMonth(3); setYear(2026); }}>Today</button>
          <button className="icon-btn" onClick={() => setMonth(m => m === 11 ? (setYear(y => y+1), 0) : m + 1)}><Icon name="chevronRight" size={13} /></button>
        </div>
      </div>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 20 }}>
        <div>
          <div className="cal-month-grid">
            {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => <div key={d} className="cal-dow">{d}</div>)}
            {cells.map((c, i) => {
              const r = c.rec;
              const status = c.otherMonth ? '' : r ? r.status : 'present';
              return (
                <div key={i} className={`cal-day status-${status} ${c.otherMonth ? 'other-month' : ''} ${isToday(c.date) ? 'today' : ''}`} onClick={() => r && onOpenRecord({ ...r })}>
                  <div className="flex items-center justify-between">
                    <span className="cal-day-num">{c.date.getDate()}</span>
                    {r && r.status === 'late' && <Icon name="clock" size={10} />}
                    {r && r.overtime > 0 && <Icon name="zap" size={10} />}
                    {r && r.status === 'leave' && <Icon name="info" size={10} />}
                    {r && r.status === 'holiday' && <Icon name="sparkles" size={10} />}
                  </div>
                  {r && r.inTime !== '—' && <span className="cal-hours">{r.inTime}</span>}
                  {r && r.hours > 0 && !c.otherMonth && <span className="cal-hours">{r.hours.toFixed(1)}h</span>}
                  {r && r.flags.length > 0 && <span className="cal-flag">{r.flags[0]}</span>}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-3" style={{ marginTop: 12, fontSize: 11, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
            {[
              { k: 'present', label: 'Present', bg: 'var(--success-soft)' },
              { k: 'late', label: 'Late', bg: 'var(--warning-soft)' },
              { k: 'leave', label: 'Leave', bg: 'var(--info-soft)' },
              { k: 'holiday', label: 'Holiday', bg: 'var(--bg-sunken)' },
              { k: 'weekend', label: 'Weekend', bg: 'transparent' },
            ].map(l => (
              <span key={l.k} className="flex items-center gap-2">
                <span style={{ width: 14, height: 14, background: l.bg, borderRadius: 3, border: '1px solid var(--border)' }} />
                {l.label}
              </span>
            ))}
          </div>
        </div>
        <div style={{ borderInlineStart: '1px solid var(--border)', paddingInlineStart: 20 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 2 }}>Rolling 14 days</div>
          <div className="text-xs text-dim" style={{ marginBottom: 14 }}>In / out plotted against policy</div>
          {history.slice(-14).reverse().map((h, i) => {
            const isActive = i === 0;
            return (
              <div key={i} className="timeline-day">
                <div className="tl-date">
                  <div className="tl-date-num">{h.date.getDate()}</div>
                  <div>{h.date.toLocaleString('en', { month: 'short', weekday: 'short' })}</div>
                </div>
                <div>
                  <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                    <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
                      <UI.StatusPill status={h.status} />
                      {h.flags.map((f, j) => <Pill key={j} kind={f.includes('OT') ? 'accent' : f.includes('Late') ? 'warning' : 'info'}>{f}</Pill>)}
                    </div>
                    <span className="mono text-xs text-dim">
                      {h.inTime !== '—' ? `${h.inTime} → ${h.outTime}` : h.flags[0] || '—'}
                    </span>
                  </div>
                  {h.status !== 'weekend' && h.status !== 'holiday' && h.status !== 'leave' && (
                    <UI.DayRuler
                      policy={{ in: 7.5, out: 15.5 }}
                      session={h.inTime !== '—' ? {
                        in: parseTimeH(h.inTime),
                        out: h.outTime !== '—' ? parseTimeH(h.outTime) : 15.5,
                      } : null}
                      events={h.inTime !== '—' ? [parseTimeH(h.inTime), 12.2, h.outTime !== '—' ? parseTimeH(h.outTime) : 15] : []}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function parseTimeH(s) {
  if (!s || s === '—') return 0;
  const [h, m] = s.split(':').map(Number);
  return h + (m || 0) / 60;
}

function RequestHistory({ me, hideFaces }) {
  const { APPROVAL_REQUESTS } = window.APP_DATA;
  const mine = APPROVAL_REQUESTS.filter(r => r.employee === me.id);
  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">My recent requests</h3>
        <button className="btn btn-sm">See all</button>
      </div>
      <table className="table">
        <thead>
          <tr><th>ID</th><th>Type</th><th>Date</th><th>Reason</th><th>Status</th></tr>
        </thead>
        <tbody>
          {(mine.length > 0 ? mine : window.APP_DATA.APPROVAL_REQUESTS.slice(0, 3)).map(r => (
            <tr key={r.id}>
              <td className="mono text-sm">{r.id}</td>
              <td>{r.type}</td>
              <td className="mono text-sm">{r.date}</td>
              <td className="text-sm">{r.reason}</td>
              <td><UI.StatusPill status={r.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

window.Employee = { EmployeeDashboard, AttendanceCalendar };
