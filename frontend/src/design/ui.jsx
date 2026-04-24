/* Reusable bits: stat cards, charts, face thumb, etc. */

function FaceThumb({ person, size = 'sm', hideFaces }) {
  const cls = size === 'sm' ? 'face-thumb' : size === 'lg' ? 'face-thumb lg' : 'face-thumb xl';
  if (hideFaces) {
    return (
      <div className={cls} style={{
        background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center',
        color: 'var(--text-tertiary)', fontSize: size === 'xl' ? 20 : 10, fontWeight: 600
      }}>{person.initials}</div>
    );
  }
  return (
    <div className={cls} style={{
      background: `radial-gradient(circle at 30% 30%, ${person.avatar}, oklch(0.3 0.05 240))`,
      color: 'white', display: 'grid', placeItems: 'center',
      fontSize: size === 'xl' ? 26 : size === 'lg' ? 14 : 10, fontWeight: 600,
      textShadow: '0 1px 2px rgba(0,0,0,0.3)'
    }}>{person.initials}</div>
  );
}

function PersonCell({ person, hideFaces, subtitle }) {
  return (
    <div className="row-person">
      <FaceThumb person={person} hideFaces={hideFaces} />
      <div style={{ minWidth: 0 }}>
        <div className="row-person-name">{person.name}</div>
        <div className="row-person-meta">{subtitle || person.id}</div>
      </div>
    </div>
  );
}

function StatCard({ label, value, delta, deltaLabel, spark, tone = 'flat', icon }) {
  return (
    <div className="stat">
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <div className="stat-label">{label}</div>
        {icon && <Icon name={icon} size={13} className="text-dim" />}
      </div>
      <div className="stat-value">{value}</div>
      <div className="flex items-center justify-between" style={{ marginTop: 4 }}>
        {delta != null && (
          <div className={`stat-delta delta-${tone}`}>
            <Icon name={tone === 'up' ? 'arrowUp' : tone === 'down' ? 'arrowDown' : 'circle'} size={10} />
            {delta}{deltaLabel && <span className="text-dim" style={{ marginLeft: 3 }}>{deltaLabel}</span>}
          </div>
        )}
        {spark && <Sparkline data={spark} />}
      </div>
    </div>
  );
}

function Sparkline({ data, color = 'var(--accent)', width = 80, height = 28 }) {
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');
  const lastX = width, lastY = height - ((data[data.length-1] - min) / range) * height;
  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  );
}

function LineChart({ data, height = 160, showGrid = true, policy }) {
  // data: [{label, value, value2?}]
  const width = 600;
  const max = Math.max(...data.flatMap(d => [d.value, d.value2 || 0]));
  const min = 0;
  const pts1 = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((d.value - min) / (max - min)) * (height - 20) - 10;
    return [x, y];
  });
  const pts2 = data.every(d => d.value2 != null) ? data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((d.value2 - min) / (max - min)) * (height - 20) - 10;
    return [x, y];
  }) : null;
  const line = (pts, color) => <polyline fill="none" stroke={color} strokeWidth="1.75" points={pts.map(p => p.join(',')).join(' ')} strokeLinecap="round" strokeLinejoin="round" />;
  const area = (pts, color) => {
    const path = `M ${pts[0][0]},${height} L ` + pts.map(p => p.join(',')).join(' L ') + ` L ${pts[pts.length-1][0]},${height} Z`;
    return <path d={path} fill={color} opacity="0.12" />;
  };
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none">
      {showGrid && [0.25, 0.5, 0.75].map(f => (
        <line key={f} x1="0" x2={width} y1={height * f} y2={height * f} stroke="var(--border)" strokeDasharray="2 3" />
      ))}
      {pts2 && <>{area(pts2, 'var(--text-tertiary)')}{line(pts2, 'var(--text-tertiary)')}</>}
      {area(pts1, 'var(--accent)')}
      {line(pts1, 'var(--accent)')}
      {data.map((d, i) => (
        <text key={i} x={(i / (data.length - 1)) * width} y={height - 2} fontSize="9" fill="var(--text-tertiary)" fontFamily="var(--font-mono)" textAnchor="middle">{d.label}</text>
      ))}
    </svg>
  );
}

function StackedBars({ data, height = 140 }) {
  // data: [{label, present, late, absent}]
  return (
    <div className="bar-chart" style={{ height }}>
      {data.map((d, i) => {
        const total = d.present + d.late + d.absent;
        return (
          <div className="bar-col" key={i}>
            <div className="bar-col-bars" style={{ gap: 0 }}>
              <div style={{ width: '100%', maxWidth: 18, display: 'flex', flexDirection: 'column', gap: 1, height: '100%', justifyContent: 'flex-end' }}>
                {d.absent > 0 && <div className="bar bar-absent" style={{ height: `${(d.absent / total) * 100}%`, maxWidth: 'none', borderRadius: 0 }} />}
                {d.late > 0 && <div className="bar bar-late" style={{ height: `${(d.late / total) * 100}%`, maxWidth: 'none', borderRadius: 0 }} />}
                {d.present > 0 && <div className="bar bar-present" style={{ height: `${(d.present / total) * 100}%`, maxWidth: 'none', borderRadius: '2px 2px 0 0' }} />}
              </div>
            </div>
            <div className="bar-label">{d.label}</div>
          </div>
        );
      })}
    </div>
  );
}

function Heatmap({ data, showAxis = true }) {
  // data: 7 rows (Sun..Sat) x 24 cols; values 0..1
  const dows = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const levels = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const color = (v) => {
    if (v < 0.05) return 'var(--bg-sunken)';
    const a = 0.15 + v * 0.85;
    return `oklch(0.58 0.1 195 / ${a})`;
  };
  return (
    <div>
      <div className="heatmap">
        {data.map((row, r) => (
          <React.Fragment key={r}>
            <div className="hm-dow">{dows[r]}</div>
            {row.map((v, c) => (
              <div key={c} className="hm-hr" style={{ background: color(v) }} title={`${dows[r]} ${c}:00 — ${Math.round(v*100)}%`} />
            ))}
          </React.Fragment>
        ))}
        {showAxis && (
          <>
            <div />
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="hm-axis">{h % 4 === 0 ? h : ''}</div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Donut({ parts, size = 120 }) {
  // parts: [{label, value, color}]
  const total = parts.reduce((s, p) => s + p.value, 0);
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--bg-sunken)" strokeWidth="16" />
      {parts.map((p, i) => {
        const frac = p.value / total;
        const dash = frac * c;
        const el = (
          <circle key={i} cx={size/2} cy={size/2} r={r} fill="none" stroke={p.color} strokeWidth="16"
            strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-offset}
            transform={`rotate(-90 ${size/2} ${size/2})`} strokeLinecap="butt" />
        );
        offset += dash;
        return el;
      })}
      <text x={size/2} y={size/2 - 2} textAnchor="middle" fontSize="20" fontFamily="var(--font-display)" fill="var(--text)" fontWeight="500">{total}</text>
      <text x={size/2} y={size/2 + 14} textAnchor="middle" fontSize="9" fill="var(--text-tertiary)" fontFamily="var(--font-mono)" style={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>total</text>
    </svg>
  );
}

function Pill({ kind = 'neutral', children, dot }) {
  return (
    <span className={`pill pill-${kind}`}>
      {dot && <span className="pill-dot" />}
      {children}
    </span>
  );
}

function StatusPill({ status }) {
  const map = {
    online: { kind: 'success', label: 'Online', dot: true },
    offline: { kind: 'danger', label: 'Offline', dot: true },
    degraded: { kind: 'warning', label: 'Degraded', dot: true },
    identified: { kind: 'success', label: 'Identified', dot: true },
    unidentified: { kind: 'warning', label: 'Unknown', dot: true },
    present: { kind: 'success', label: 'Present' },
    late: { kind: 'warning', label: 'Late' },
    absent: { kind: 'danger', label: 'Absent' },
    leave: { kind: 'info', label: 'Leave' },
    holiday: { kind: 'neutral', label: 'Holiday' },
    weekend: { kind: 'neutral', label: 'Weekend' },
    'pending-mgr': { kind: 'warning', label: 'Pending manager' },
    'pending-hr': { kind: 'info', label: 'Pending HR' },
    approved: { kind: 'success', label: 'Approved' },
    rejected: { kind: 'danger', label: 'Rejected' },
    ok: { kind: 'success', label: 'OK' },
    retry: { kind: 'warning', label: 'Retry' },
  };
  const p = map[status] || { kind: 'neutral', label: status };
  return <Pill kind={p.kind} dot={p.dot}>{p.label}</Pill>;
}

function DayRuler({ policy = { in: 7.5, out: 15.5 }, session, events = [] }) {
  // Hours 0-24. Shows policy window, session span, event ticks
  const pct = (h) => `${(h / 24) * 100}%`;
  const widthPct = (from, to) => `${((to - from) / 24) * 100}%`;
  return (
    <div className="day-ruler">
      {[6, 12, 18].map(h => <div key={h} className="day-ruler-hour" style={{ left: pct(h) }} />)}
      {[0, 6, 12, 18, 24].map(h => (
        <div key={h} className="day-ruler-tick-label" style={{ left: pct(h) }}>{h.toString().padStart(2,'0')}</div>
      ))}
      {policy && <div className="day-ruler-policy" style={{ left: pct(policy.in), width: widthPct(policy.in, policy.out) }} />}
      {session && <div className="day-ruler-session" style={{ left: pct(session.in), width: widthPct(session.in, session.out) }} />}
      {events.map((e, i) => <div key={i} className="day-ruler-event" style={{ left: pct(e) }} />)}
    </div>
  );
}

function SectionHeader({ title, sub, right }) {
  return (
    <div className="flex items-center justify-between mb-2" style={{ marginTop: 20 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
        {sub && <div className="text-xs text-dim" style={{ marginTop: 2 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
}

window.UI = { FaceThumb, PersonCell, StatCard, Sparkline, LineChart, StackedBars, Heatmap, Donut, Pill, StatusPill, DayRuler, SectionHeader };
