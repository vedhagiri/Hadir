/* Sample data — Omani/Arabic names, realistic departments */

const DEPARTMENTS = [
  { id: 'ops', name: 'Operations', head: 'Sultan Al-Busaidi', count: 28 },
  { id: 'fin', name: 'Finance', head: 'Mariam Al-Rashdi', count: 14 },
  { id: 'hr', name: 'Human Resources', head: 'Hind Al-Lawati', count: 9 },
  { id: 'it', name: 'IT & Security', head: 'Yousef Al-Hinai', count: 16 },
  { id: 'eng', name: 'Engineering', head: 'Khalid Al-Zadjali', count: 32 },
  { id: 'leg', name: 'Legal & Compliance', head: 'Aisha Al-Habsi', count: 7 },
];

const EMPLOYEES = [
  { id: 'OM0012', name: 'Aisha Al-Habsi', role: 'HR', dept: 'hr', email: 'aisha.habsi@omran.om', mgr: null, designation: 'HR Director', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.68 0.12 20)', initials: 'AH' },
  { id: 'OM0097', name: 'Sultan Al-Busaidi', role: 'Manager', dept: 'ops', email: 'sultan.busaidi@omran.om', mgr: 'OM0003', designation: 'Operations Lead', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.65 0.13 160)', initials: 'SB' },
  { id: 'OM0045', name: 'Fatima Al-Kindi', role: 'Employee', dept: 'ops', email: 'fatima.kindi@omran.om', mgr: 'OM0097', designation: 'Operations Analyst', policy: 'Flex 07:30–16:30', avatar: 'oklch(0.62 0.14 340)', initials: 'FK' },
  { id: 'OM0128', name: 'Hassan Al-Balushi', role: 'Employee', dept: 'eng', email: 'hassan.balushi@omran.om', mgr: 'OM0033', designation: 'Site Engineer', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.6 0.14 240)', initials: 'HB' },
  { id: 'OM0033', name: 'Khalid Al-Zadjali', role: 'Manager', dept: 'eng', email: 'khalid.zadjali@omran.om', mgr: 'OM0003', designation: 'Engineering Manager', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.6 0.12 90)', initials: 'KZ' },
  { id: 'OM0201', name: 'Noor Al-Saidi', role: 'Employee', dept: 'fin', email: 'noor.saidi@omran.om', mgr: 'OM0088', designation: 'Senior Accountant', policy: 'Flex 07:30–16:30', avatar: 'oklch(0.66 0.13 30)', initials: 'NS' },
  { id: 'OM0088', name: 'Mariam Al-Rashdi', role: 'Manager', dept: 'fin', email: 'mariam.rashdi@omran.om', mgr: 'OM0003', designation: 'Finance Manager', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.64 0.12 310)', initials: 'MR' },
  { id: 'OM0156', name: 'Yousef Al-Hinai', role: 'Manager', dept: 'it', email: 'yousef.hinai@omran.om', mgr: 'OM0003', designation: 'IT Security Lead', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.6 0.13 200)', initials: 'YH' },
  { id: 'OM0221', name: 'Layla Al-Mahrouqi', role: 'Employee', dept: 'eng', email: 'layla.mahrouqi@omran.om', mgr: 'OM0033', designation: 'Software Engineer', policy: 'Flex 07:30–16:30', avatar: 'oklch(0.64 0.14 10)', initials: 'LM' },
  { id: 'OM0267', name: 'Omar Al-Farsi', role: 'Employee', dept: 'ops', email: 'omar.farsi@omran.om', mgr: 'OM0097', designation: 'Field Supervisor', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.6 0.12 120)', initials: 'OF' },
  { id: 'OM0302', name: 'Hind Al-Lawati', role: 'Manager', dept: 'hr', email: 'hind.lawati@omran.om', mgr: null, designation: 'HR Manager', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.66 0.13 280)', initials: 'HL' },
  { id: 'OM0311', name: 'Saif Al-Maamari', role: 'Employee', dept: 'it', email: 'saif.maamari@omran.om', mgr: 'OM0156', designation: 'Network Engineer', policy: 'Flex 07:30–16:30', avatar: 'oklch(0.62 0.13 180)', initials: 'SM' },
  { id: 'OM0345', name: 'Rania Al-Nabhani', role: 'Employee', dept: 'fin', email: 'rania.nabhani@omran.om', mgr: 'OM0088', designation: 'Accountant', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.65 0.12 50)', initials: 'RN' },
  { id: 'OM0378', name: 'Ahmed Al-Siyabi', role: 'Employee', dept: 'eng', email: 'ahmed.siyabi@omran.om', mgr: 'OM0033', designation: 'QA Engineer', policy: 'Fixed 07:30–15:30', avatar: 'oklch(0.6 0.12 150)', initials: 'AS' },
  { id: 'OM0410', name: 'Zainab Al-Riyami', role: 'Employee', dept: 'leg', email: 'zainab.riyami@omran.om', mgr: 'OM0003', designation: 'Legal Counsel', policy: 'Flex 07:30–16:30', avatar: 'oklch(0.64 0.13 350)', initials: 'ZR' },
  { id: 'OM0003', name: 'Tariq Al-Shukaili', role: 'Admin', dept: 'it', email: 'tariq.shukaili@omran.om', mgr: null, designation: 'Chief Admin', policy: 'Fixed 08:00–16:00', avatar: 'oklch(0.55 0.14 250)', initials: 'TS' },
];

const CAMERAS = [
  { id: 'CAM-01', name: 'Main Lobby — Entry', location: 'HQ Ground Floor', zone: 'entry', status: 'online', uptime: 99.8, events: 1284, fps: 4.2 },
  { id: 'CAM-02', name: 'Main Lobby — Exit', location: 'HQ Ground Floor', zone: 'exit', status: 'online', uptime: 99.6, events: 1142, fps: 4.1 },
  { id: 'CAM-03', name: 'Basement Parking', location: 'HQ Basement', zone: 'entry', status: 'online', uptime: 98.2, events: 412, fps: 3.9 },
  { id: 'CAM-04', name: 'East Wing — Side Door', location: 'HQ East', zone: 'entry', status: 'degraded', uptime: 87.1, events: 189, fps: 2.8 },
  { id: 'CAM-05', name: 'Workshop Floor 2', location: 'Workshop', zone: 'entry', status: 'online', uptime: 99.9, events: 312, fps: 4.3 },
  { id: 'CAM-06', name: 'Warehouse Back Gate', location: 'Warehouse', zone: 'entry', status: 'offline', uptime: 0, events: 0, fps: 0 },
  { id: 'CAM-07', name: 'Reception — Ground', location: 'HQ Ground Floor', zone: 'entry', status: 'online', uptime: 99.4, events: 876, fps: 4.0 },
  { id: 'CAM-08', name: 'Cafeteria Entry', location: 'HQ Floor 3', zone: 'entry', status: 'online', uptime: 99.1, events: 654, fps: 4.2 },
];

const SHIFT_POLICIES = [
  { id: 'fixed-std', name: 'Standard Fixed', type: 'Fixed', in: '07:30', out: '15:30', hours: 8, assigned: 78, active: true, description: 'Default for most departments' },
  { id: 'flex-std', name: 'Standard Flex', type: 'Flex', in: '07:30–08:30', out: '15:30–16:30', hours: 8, assigned: 24, active: true, description: 'Must complete 8 hours' },
  { id: 'ramadan', name: 'Ramadan 2026', type: 'Ramadan', in: '09:00', out: '14:00', hours: 5, assigned: 106, active: false, description: 'Applies during Ramadan period only', window: 'Mar 1 – Apr 1, 2026' },
  { id: 'night', name: 'Night Shift', type: 'Custom', in: '19:00', out: '03:00', hours: 8, assigned: 4, active: true, description: 'Security & warehouse night rotation' },
  { id: 'admin', name: 'Admin Hours', type: 'Fixed', in: '08:00', out: '16:00', hours: 8, assigned: 6, active: true, description: 'Senior admin staff' },
];

/* Generate attendance history for Fatima (current employee)
   Last 30 days. Status and times. */
function genAttendance(seed = 7) {
  const rnd = mulberry32(seed);
  const today = new Date('2026-04-23'); // frozen today for deterministic UI
  const history = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dow = d.getDay();
    const dayOfMonth = d.getDate();
    const isWeekend = dow === 5 || dow === 6; // Friday/Saturday in Oman
    let status = 'present';
    let inTime = '07:28', outTime = '15:34';
    let flags = [];
    let hours = 8.1;
    let overtime = 0;
    if (isWeekend) { status = 'weekend'; inTime = '—'; outTime = '—'; hours = 0; }
    else if (dayOfMonth === 10) { status = 'leave'; inTime = '—'; outTime = '—'; hours = 0; flags = ['Annual leave']; }
    else if (dayOfMonth === 15) { status = 'holiday'; inTime = '—'; outTime = '—'; hours = 0; flags = ['National Day']; }
    else {
      const r = rnd();
      if (r < 0.15) {
        status = 'late';
        const mins = Math.floor(rnd() * 40) + 10;
        const h = 7 + Math.floor((30 + mins) / 60);
        const m = (30 + mins) % 60;
        inTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;
        flags = [`Late ${mins}m`];
        hours = 7.5 - mins / 60;
      } else if (r < 0.22) {
        status = 'present';
        const extraMin = Math.floor(rnd() * 80) + 20;
        const h = 15 + Math.floor((30 + extraMin) / 60);
        const m = (30 + extraMin) % 60;
        outTime = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}`;
        overtime = +(extraMin / 60).toFixed(1);
        flags = [`+${overtime}h OT`];
        hours = 8 + overtime;
      }
      hours = +hours.toFixed(1);
    }
    history.push({ date: d, status, inTime, outTime, flags, hours, overtime });
  }
  return history;
}

function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const APPROVAL_REQUESTS = [
  { id: 'REQ-1048', employee: 'OM0045', type: 'Late-in', date: '2026-04-22', reason: 'Doctor\'s appointment', notes: 'Followup with cardiologist at 09:00. Expected to be 45m late.', status: 'pending-hr', submitted: '2026-04-20 14:32', attachment: 'medical-note.pdf', chain: [{ by: 'Sultan Al-Busaidi', at: '2026-04-20 16:10', decision: 'approved', note: 'Standard medical exception.' }] },
  { id: 'REQ-1047', employee: 'OM0128', type: 'Early-out', date: '2026-04-22', reason: 'Family emergency', notes: 'Need to pick up daughter from school — called in by nurse.', status: 'pending-mgr', submitted: '2026-04-22 11:04', attachment: null, chain: [] },
  { id: 'REQ-1046', employee: 'OM0201', type: 'Special absence', date: '2026-04-21', reason: 'Government appointment', notes: 'ROP document renewal — will return same day.', status: 'approved', submitted: '2026-04-19 09:15', attachment: 'appointment.pdf', chain: [
    { by: 'Mariam Al-Rashdi', at: '2026-04-19 14:00', decision: 'approved', note: 'Fine.' },
    { by: 'Aisha Al-Habsi', at: '2026-04-19 16:40', decision: 'approved', note: 'Approved — deduct from personal leave.' },
  ] },
  { id: 'REQ-1045', employee: 'OM0267', type: 'Late-in', date: '2026-04-20', reason: 'Traffic', notes: 'Road closure on Muscat Expressway.', status: 'rejected', submitted: '2026-04-20 10:45', attachment: null, chain: [
    { by: 'Sultan Al-Busaidi', at: '2026-04-20 11:20', decision: 'rejected', note: 'Insufficient justification; same reason last week.' },
  ] },
  { id: 'REQ-1044', employee: 'OM0221', type: 'Late-in', date: '2026-04-19', reason: 'Transportation', notes: 'Bus cancelled.', status: 'pending-hr', submitted: '2026-04-19 08:42', attachment: null, chain: [{ by: 'Khalid Al-Zadjali', at: '2026-04-19 11:30', decision: 'approved', note: 'OK for this instance.' }] },
  { id: 'REQ-1043', employee: 'OM0311', type: 'Early-out', date: '2026-04-18', reason: 'Personal', notes: 'Family event.', status: 'pending-mgr', submitted: '2026-04-18 13:10', attachment: null, chain: [] },
  { id: 'REQ-1042', employee: 'OM0378', type: 'Late-in', date: '2026-04-22', reason: 'Medical', notes: 'Dentist appointment.', status: 'pending-mgr', submitted: '2026-04-22 07:55', attachment: 'dentist.pdf', chain: [] },
];

/* Live events feed — last hour */
const LIVE_EVENTS = [
  { t: '08:47:12', cam: 'CAM-01', empId: 'OM0045', empName: 'Fatima Al-Kindi', confidence: 0.97, status: 'identified' },
  { t: '08:46:58', cam: 'CAM-07', empId: 'OM0128', empName: 'Hassan Al-Balushi', confidence: 0.94, status: 'identified' },
  { t: '08:45:33', cam: 'CAM-01', empId: null, empName: 'Unknown', confidence: 0.48, status: 'unidentified' },
  { t: '08:44:01', cam: 'CAM-01', empId: 'OM0221', empName: 'Layla Al-Mahrouqi', confidence: 0.99, status: 'identified' },
  { t: '08:42:47', cam: 'CAM-03', empId: 'OM0033', empName: 'Khalid Al-Zadjali', confidence: 0.98, status: 'identified' },
  { t: '08:41:15', cam: 'CAM-01', empId: 'OM0201', empName: 'Noor Al-Saidi', confidence: 0.95, status: 'identified' },
  { t: '08:40:03', cam: 'CAM-07', empId: 'OM0267', empName: 'Omar Al-Farsi', confidence: 0.93, status: 'identified' },
  { t: '08:38:22', cam: 'CAM-08', empId: 'OM0088', empName: 'Mariam Al-Rashdi', confidence: 0.96, status: 'identified' },
  { t: '08:37:54', cam: 'CAM-01', empId: 'OM0378', empName: 'Ahmed Al-Siyabi', confidence: 0.91, status: 'identified' },
  { t: '08:36:11', cam: 'CAM-05', empId: null, empName: 'Unknown', confidence: 0.42, status: 'unidentified' },
  { t: '08:35:47', cam: 'CAM-01', empId: 'OM0097', empName: 'Sultan Al-Busaidi', confidence: 0.99, status: 'identified' },
  { t: '08:34:29', cam: 'CAM-07', empId: 'OM0345', empName: 'Rania Al-Nabhani', confidence: 0.92, status: 'identified' },
];

const HOLIDAYS_2026 = [
  { date: '2026-01-01', name: 'New Year\'s Day' },
  { date: '2026-02-18', name: 'Isra and Mi\'raj' },
  { date: '2026-03-20', name: 'Ramadan begins' },
  { date: '2026-04-20', name: 'Eid al-Fitr (Day 1)' },
  { date: '2026-04-21', name: 'Eid al-Fitr (Day 2)' },
  { date: '2026-04-22', name: 'Eid al-Fitr (Day 3)' },
  { date: '2026-07-23', name: 'Renaissance Day' },
  { date: '2026-11-18', name: 'National Day' },
];

const REPORT_SCHEDULES = [
  { id: 'sch-01', name: 'HR Daily Attendance', type: 'Daily Attendance', schedule: 'Daily · 08:00', recipients: ['hr-all@omran.om', 'it-ops@omran.om'], method: 'Email (xlsx)', lastRun: '2026-04-23 08:00', status: 'ok' },
  { id: 'sch-02', name: 'Ops Department Weekly', type: 'Department Summary', schedule: 'Weekly · Sun 07:30', recipients: ['ops-leads@omran.om'], method: 'Email (pdf)', lastRun: '2026-04-19 07:30', status: 'ok' },
  { id: 'sch-03', name: 'Monthly Audit Export', type: 'Event Log', schedule: 'Monthly · 1st · 06:00', recipients: ['audit@omran.om'], method: 'Download link', lastRun: '2026-04-01 06:00', status: 'ok' },
  { id: 'sch-04', name: 'Exceptions Digest', type: 'Approvals Report', schedule: 'Weekly · Thu 16:00', recipients: ['hr-leads@omran.om'], method: 'Email (pdf)', lastRun: '2026-04-16 16:00', status: 'retry' },
];

window.APP_DATA = { DEPARTMENTS, EMPLOYEES, CAMERAS, SHIFT_POLICIES, APPROVAL_REQUESTS, LIVE_EVENTS, HOLIDAYS_2026, REPORT_SCHEDULES, genAttendance };
