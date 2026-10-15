import { useEffect, useRef, useState } from 'react';
import Vantiq from './services/vantiq.js';
import { subscribeToUIUpdates } from './services/updates.js';
import { useAuth } from './contexts/AuthContext.jsx';
import { EVENT_SAMPLE, SOURCES } from './data.js';

// Vantiq procedure that joins the plant MES, Supplier A and Supplier B systems into the board.
const BOARD_PROCEDURE = 'com.vantiqse.imo.Board.getSequenceBoard';
const BOARD_POLL_MS = 3000;
// Clears what Vantiq holds between demo runs (active Issue collaborations).
const RESET_PROCEDURE = 'com.vantiqse.utils.Demo.reset';
const STAGE_LABEL = { QUEUED: 'Queued', PICKING: 'Picking', SEQUENCED: 'Sequenced', STAGED: 'Staged', ON_TUGGER: 'On tugger' };

const SIM_URL = import.meta.env.VITE_SIM_URL || 'http://127.0.0.1:8765';
const SIDEBAR_WIDTH = 200;
const DEFAULT_COST_PER_MIN = 25000;
const money = (x) => `$${Number(x || 0).toLocaleString('en-US')}`;

const pad = (x) => String(x).padStart(2, '0');
const mmss = (sec) => `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
// Log times use the viewer's own clock, so every entry reads on the same one.
const timeOf = (ms) => new Date(ms).toLocaleTimeString('en-GB');
// The starting entry is stamped a little in the past, so the shift reads as already running.
const SEED_AGE_MS = 20 * 60 * 1000;
const seedEntry = (startedAt) => ({
  t: timeOf(startedAt - SEED_AGE_MS),
  tag: 'PLANT',
  event: 'Build-order rev 117 received. 12 vehicles in the next window.',
  action: 'Sequence calculated, picks released to Supplier A',
});

const TAG_CLASS = {
  'BUILD ORDER': 'chip chip-info',
  QUALITY: 'chip chip-act',
  SUPPLIER: 'chip chip-info',
  EQUIPMENT: 'chip chip-crit',
  PLANT: 'chip chip-neutral',
};


const STATE_OF_INCIDENT = (inc) => (inc.released ? 'released' : inc.onTugger ? 'ontugger' : inc.picked ? 'picked' : inc.reserved ? 'reserved' : inc.noSpare ? 'nospare' : 'open');

// One-line callout on the vehicle's row: what the back end is doing right now.
const incidentNote = (inc) => {
  const st = STATE_OF_INCIDENT(inc);
  if (st === 'released') return 'Supplier A released the hold: replacement on its way';
  if (st === 'ontugger') return `Supplier B assigned the replacement to tugger ${inc.tugger}`;
  if (st === 'picked') return inc.tugger ? `Supplier A picked the replacement (bin ${inc.bin}), Vantiq asked for tugger ${inc.tugger}` : `Supplier A picked the replacement (bin ${inc.bin})`;
  if (st === 'reserved') return `Vantiq reserved a spare (bin ${inc.bin}), waiting on Supplier A to pick`;
  if (st === 'nospare') return 'Vantiq found no spare in stock';
  return '';
};

// A hold is on the seat set only, not the line. The chip says what is being done about it.
const holdStatus = (inc) => {
  if (!inc) return 'On hold: finding replacement';
  const st = STATE_OF_INCIDENT(inc);
  if (st === 'nospare') return 'On hold: no spare';
  if (st === 'ontugger') return `On hold: replacement on ${inc.tugger}`;
  if (st === 'picked') return 'On hold: replacement picked';
  if (st === 'reserved') return 'On hold: replacement reserved';
  return 'On hold: finding replacement';
};

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB') : '');

// The damaged seat's path, step by step, with who does each step. Steps not reached yet show as waiting.
const incidentSteps = (inc) => [
  { actor: 'Supplier A', text: `Vision check fails at ${inc.station || 'inspection'}: ${inc.defect || 'seat damaged'}`, at: inc.failedTs },
  { actor: 'Supplier A', text: 'Supplier A system places a hold on the seat set', at: inc.heldTs },
  inc.noSpare
    ? { actor: 'Vantiq', text: `No spare ${inc.seatSpec || ''} in stock. Needs a person to decide`, at: inc.noSpare, warn: true }
    : { actor: 'Vantiq', text: `Vantiq finds a spare and reserves it${inc.bin ? ` (bin ${inc.bin})` : ''}`, at: inc.reserved },
  { actor: 'Supplier A', text: 'Warehouse picker takes the spare from the bin', at: inc.picked },
  { actor: 'Vantiq', text: inc.checkSummary || 'Vantiq checks the tuggers (Supplier B) and their chargers (OPC UA)', at: inc.checkedTs },
  { actor: 'Vantiq', text: `Vantiq asks Supplier B to carry the replacement${inc.tugger ? ` on ${inc.tugger}` : ''}`, at: inc.assignedTs },
  { actor: 'Supplier B', text: `Supplier B assigns the replacement to tugger${inc.tugger ? ` ${inc.tugger}` : ''}`, at: inc.onTugger },
  { actor: 'Supplier A', text: 'Hold released, the replacement continues as the seat set. Vantiq closes the case', at: inc.released },
];

// The tugger fault's path, step by step, with who does each step.
const tuggerFaultSteps = (f) => [
  { actor: 'Supplier B', text: `Tugger ${f.tugger} reports fault ${f.code || ''}${f.description ? ` (${f.description})` : ''}${f.carrying?.length ? `, carrying seq ${f.carrying.join(', ')}` : ''}`, at: f.faultTs },
  { actor: 'Vantiq', text: f.checkSummary || 'Vantiq finds the seat sets on the tugger and checks the other tuggers and chargers', at: f.checkedTs },
  f.unplaced > 0 && !f.moves?.length
    ? { actor: 'Vantiq', text: 'No healthy tugger available. Needs a person to decide', at: f.assignedTs, warn: true }
    : { actor: 'Vantiq', text: f.assignSummary || 'Vantiq asks Supplier B to move the seat sets', at: f.assignedTs },
  { actor: 'Supplier B', text: `Supplier B moves ${f.moves?.length ?? ''} seat sets off ${f.tugger}`, at: f.movedTs },
  { actor: 'Vantiq', text: f.tightestBufferSec != null ? `Vantiq recomputes the buffer: tightest ${mmss(f.tightestBufferSec)}, line-stop risk ${f.risk}` : 'Vantiq recomputes the buffer and the line-stop risk', at: f.recomputedTs },
];

export default function App() {
  const [flags, setFlags] = useState({ reorder: false, damage: false, tugger: false });
  const [log, setLog] = useState([]);
  const [startedAt, setStartedAt] = useState(() => Date.now());   // when this run began; the starting log entry is dated from it
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState('dashboard');
  const { profile, handleLogout } = useAuth();
  const [board, setBoard] = useState(null);
  const [boardAt, setBoardAt] = useState(Date.now());
  const [simSpeed, setSimSpeed] = useState(1);
  const [, setTick] = useState(0);   // re-render each second so the "Need in" countdown ticks
  const [boardError, setBoardError] = useState('');
  const [resetError, setResetError] = useState('');
  // Back-end activity for the damaged seat, built from the UI updates Vantiq pushes (keyed by VIN).
  const [incidents, setIncidents] = useState({});
  // The tugger fault handled by Vantiq, built from its UI updates ({tugger, code, moves, ...}), or null.
  const [tuggerFault, setTuggerFault] = useState(null);
  // Pick-queue changes after a build-order revision, keyed by VIN: {note, confirmed}.
  const [moves, setMoves] = useState({});
  // Seconds from the triggering event to Vantiq's action, measured from the timestamps on the last UI update.
  const [eventToAction, setEventToAction] = useState(null);
  const [costPerMin, setCostPerMin] = useState(() => {
    try {
      const v = localStorage.getItem('cost-per-min');
      return v === null ? DEFAULT_COST_PER_MIN : Number(v);
    } catch {
      return DEFAULT_COST_PER_MIN;
    }
  });
  const updateCost = (v) => {
    setCostPerMin(v);
    try { localStorage.setItem('cost-per-min', String(v)); } catch { /* storage unavailable */ }
  };

  // The tab can be dragged along the bottom edge. tabLeft is px from the left of the
  // viewport; null means the default spot at the right.
  const [tabLeft, setTabLeft] = useState(() => {
    try {
      const v = localStorage.getItem('sim-tab-left');
      return v === null ? null : Number(v);
    } catch {
      return null;
    }
  });
  const tabRef = useRef(null);
  const drag = useRef(null);
  const clampLeft = (x) => Math.max(SIDEBAR_WIDTH, Math.min(x, window.innerWidth - (tabRef.current?.offsetWidth ?? 0)));

  useEffect(() => {
    const onResize = () => setTabLeft((x) => (x === null ? x : clampLeft(x)));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The tab and panel are one element (drawerRef) so they always move together.
  // Dragging the tab up or down pulls the drawer with the pointer; dragging sideways
  // slides the tab. The first few pixels of movement decide which.
  // dragY is the drawer's offset in px while pulling (0 = open, height = closed).
  const drawerRef = useRef(null);
  const [dragY, setDragY] = useState(null);

  const onTabDown = (e) => {
    const h = drawerRef.current.offsetHeight;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: tabRef.current.getBoundingClientRect().left,
      startOffset: drawerOpen ? 0 : h,
      height: h,
      axis: null,
      lastY: e.clientY,
      lastT: e.timeStamp,
      vy: 0,
    };
    tabRef.current.setPointerCapture(e.pointerId);
  };
  const onTabMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.axis) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 5) return;
      d.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (d.axis === 'x') {
      setTabLeft(clampLeft(d.startLeft + dx));
    } else {
      const dt = e.timeStamp - d.lastT;
      if (dt > 0) d.vy = (e.clientY - d.lastY) / dt;
      d.lastY = e.clientY;
      d.lastT = e.timeStamp;
      setDragY(Math.max(0, Math.min(d.height, d.startOffset + dy)));
    }
  };
  const onTabUp = (e) => {
    const d = drag.current;
    if (!d) return;
    if (d.axis === 'x') {
      try { localStorage.setItem('sim-tab-left', String(Math.round(tabRef.current.getBoundingClientRect().left))); } catch { /* ignore */ }
    } else if (d.axis === 'y') {
      const offset = Math.max(0, Math.min(d.height, d.startOffset + (e.clientY - d.startY)));
      // A quick flick decides it; otherwise whichever side of halfway the drawer is on.
      const open = Math.abs(d.vy) > 0.4 ? d.vy < 0 : offset < d.height / 2;
      setDrawerOpen(open);
      setDragY(null);
    }
  };
  const onTabClick = () => {
    // A drag ends with a click event; ignore it so dragging does not toggle the drawer.
    const moved = drag.current?.axis;
    drag.current = null;
    if (moved) return;
    setDrawerOpen((o) => !o);
  };
  const onTabKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = tabRef.current.getBoundingClientRect().left;
    const next = clampLeft(cur + (e.key === 'ArrowLeft' ? -32 : 32));
    setTabLeft(next);
    try { localStorage.setItem('sim-tab-left', String(Math.round(next))); } catch { /* ignore */ }
  };

  // The board reads the three systems of record through Vantiq; the simulator keeps them current.
  useEffect(() => {
    let stopped = false;
    const load = () => {
      // The simulator's speed turns real seconds into sim seconds for the "Need in" countdown.
      fetch(`${SIM_URL}/status`)
        .then((r) => r.json())
        .then((st) => { if (!stopped) setSimSpeed(st.paused ? 0 : st.speed || 1); })
        .catch(() => { /* no simulator reachable: keep the last speed */ });
      return Vantiq.execute(BOARD_PROCEDURE)
        .then((b) => { if (!stopped) { setBoard(b); setBoardAt(Date.now()); setBoardError(''); } })
        .catch((e) => { if (!stopped) setBoardError(e.message || 'Could not read the board from Vantiq'); });
    };
    load();
    const id = setInterval(load, BOARD_POLL_MS);
    const tickId = setInterval(() => setTick((t) => t + 1), 1000);
    return () => { stopped = true; clearInterval(id); clearInterval(tickId); };
  }, []);

  // UI updates pushed by Vantiq (one subscription for every kind), shown in the incident panel and the event log.
  useEffect(
    () =>
      subscribeToUIUpdates((u) => {
        // The plant message (or the later of the failed scan and the hold) to the moment Vantiq acted.
        const from = u.kind === 'BuildOrderChanged' ? u.eventTs : u.kind === 'TuggerFault' ? u.faultTs : u.kind === 'ReplacementReserved' || u.kind === 'NoReplacementAvailable' ? [u.failedTs, u.heldTs].sort().pop() : null;
        if (from && u.ts) {
          const sec = (Date.parse(u.ts) - Date.parse(from)) / 1000;
          if (sec >= 0 && sec < 600) setEventToAction(sec);
        }
        if (u.kind === 'BuildOrderChanged') {
          setMoves((prev) => {
            const next = { ...prev };
            for (const m of u.moved || []) next[m.vin] = { note: m.note, priority: m.priority, confirmed: false };
            return next;
          });
          setLog((prev) => [{ t: new Date().toLocaleTimeString('en-GB'), tag: 'BUILD ORDER', event: `Plant revised the build order (rev ${u.rev})`, action: u.summary }, ...prev]);
          return;
        }
        if (u.kind === 'PickQueueConfirmed') {
          setMoves((prev) => (prev[u.vin] ? { ...prev, [u.vin]: { ...prev[u.vin], confirmed: true } } : prev));
          setLog((prev) => [{ t: new Date().toLocaleTimeString('en-GB'), tag: 'SUPPLIER', event: `Seq ${u.seq} (${u.vin}): new pick order`, action: u.summary }, ...prev]);
          return;
        }
        if (u.kind === 'TuggerFault') {
          setTuggerFault({ ...u, assignSummary: u.summary });
          setLog((prev) => [{ t: new Date().toLocaleTimeString('en-GB'), tag: 'EQUIPMENT', event: `Tugger ${u.tugger} reported fault ${u.code}${u.description ? ` (${u.description})` : ''}`, action: u.unplaced > 0 && !u.moves?.length ? 'No healthy tugger available, needs a person to decide' : u.summary }, ...prev]);
          return;
        }
        if (u.kind === 'TuggerReassigned') {
          setTuggerFault((prev) => ({ ...(prev || { tugger: u.tugger }), movedTs: u.ts, recomputedTs: u.recomputedTs, tightestBufferSec: u.tightestBufferSec, risk: u.risk }));
          setLog((prev) => [{ t: new Date().toLocaleTimeString('en-GB'), tag: 'SUPPLIER', event: u.summary, action: u.tightestBufferSec != null ? `Vantiq recomputed the buffer: tightest ${mmss(u.tightestBufferSec)}, line-stop risk ${u.risk}` : 'Vantiq recomputed the buffer' }, ...prev]);
          return;
        }
        setIncidents((prev) => {
          const cur = prev[u.vin] || { vin: u.vin };
          if (u.kind === 'ReplacementReserved' || u.kind === 'NoReplacementAvailable') {
            return { ...prev, [u.vin]: { ...cur, ...u, reserved: u.kind === 'ReplacementReserved' ? u.ts : null, noSpare: u.kind === 'NoReplacementAvailable' ? u.ts : null } };
          }
          if (u.kind === 'ReplacementPicked') {
            return { ...prev, [u.vin]: { ...cur, bin: u.bin || cur.bin, picked: u.ts, tugger: u.tugger || cur.tugger, charger: u.charger, chargePct: u.chargePct, checkSummary: u.checkSummary, checkedTs: u.checkedTs, assignedTs: u.assignedTs } };
          }
          if (u.kind === 'ReplacementOnTugger') return { ...prev, [u.vin]: { ...cur, tugger: u.tugger || cur.tugger, onTugger: u.ts } };
          if (u.kind === 'HoldReleased') return { ...prev, [u.vin]: { ...cur, released: u.ts } };
          return prev;
        });
        const tag = u.kind === 'NoReplacementAvailable' ? 'EQUIPMENT' : u.kind === 'ReplacementReserved' ? 'QUALITY' : 'SUPPLIER';
        const event = `Seq ${u.seq} (${u.vin}): ${u.summary}`;
        const action =
          u.kind === 'ReplacementReserved' ? `Vantiq reserved the spare from bin ${u.bin}` :
          u.kind === 'ReplacementPicked' ? (u.tugger ? `Supplier A picked the replacement; Vantiq checked ${u.charger} (${u.chargePct}%) and asked for tugger ${u.tugger}` : 'Supplier A picked the replacement; Vantiq found no tugger') :
          u.kind === 'ReplacementOnTugger' ? `Supplier B assigned the replacement to tugger ${u.tugger}` :
          u.kind === 'HoldReleased' ? 'Hold released, case closed in Vantiq' : 'No replacement in stock';
        setLog((prev) => [{ t: new Date().toLocaleTimeString('en-GB'), tag, event, action }, ...prev]);
      }),
    [],
  );

  // Tell the simulator to publish the event. The dashboard still runs its own mock
  // until it reads state from Vantiq, so a failure here is shown but not fatal.
  const [simError, setSimError] = useState(false);
  const callSim = (path) =>
    fetch(`${SIM_URL}${path}`, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error(r.status); setSimError(false); })
      .catch(() => setSimError(true));

  const fire = (key, tag, event, action) => {
    if (flags[key]) return;
    callSim(`/scenario/${key}`);
    setFlags({ ...flags, [key]: true });
    // The build-order change and the tugger fault are logged from Vantiq's own updates, so they get no mock line here.
    if (key !== 'reorder' && key !== 'tugger') {
      setLog([{ t: timeOf(Date.now()), tag, event, action }, ...log]);
    }
  };

  const reset = () => {
    // Vantiq first, so the simulator's fresh state never meets a collaboration left from the last run.
    Vantiq.execute(RESET_PROCEDURE)
      .then(() => setResetError(''))
      .catch((e) => setResetError(e.message || 'Vantiq reset failed'))
      .finally(() => callSim('/reset'));
    setFlags({ reorder: false, damage: false, tugger: false });
    setLog([]);
    setIncidents({});
    setTuggerFault(null);
    setMoves({});
    setEventToAction(null);
    setStartedAt(Date.now());
  };

  // The tightest buffer and the risk come from Vantiq (planned slack minus the delay from holds, pending
  // replacements and tugger faults).
  const slackSec = board?.tightestBufferSec ?? null;
  const watch = slackSec !== null && slackSec < (board?.watchSec ?? 600);
  // Sim seconds since the plant MES wrote the need times: the board's age at the server, plus time since we read it.
  const simElapsed = board?.asOf && board?.serverNow
    ? ((Date.parse(board.serverNow) - Date.parse(board.asOf)) / 1000 + (Date.now() - boardAt) / 1000) * simSpeed
    : 0;
  const handled = Object.values(flags).filter(Boolean).length;

  const rows = (board?.rows || []).map((r) => {
    const faulted = r.tuggerFault ? `Tugger ${r.tugger} fault ${r.tuggerFault}` : r.movedFrom ? `Moved from ${r.movedFrom} to ${r.tugger}` : '';
    const held = r.hold ? `Hold: ${r.defect || 'quality'}` : '';
    const inc = incidents[r.vin];
    const backend = inc ? incidentNote(inc) : '';
    const mv = moves[r.vin];
    const moved = mv ? `${mv.note === 'pulled forward' ? 'Pulled forward' : 'Pushed back'}${mv.confirmed ? ', Supplier A confirmed pick ' + mv.priority : ', waiting on Supplier A'}` : '';
    const note = [held, faulted, backend, moved].filter(Boolean).join(' · ');
    const status = r.hold ? holdStatus(incidents[r.vin]) : STAGE_LABEL[r.stage] || r.stage;
    const tone = note ? 'act' : r.stage === 'QUEUED' || r.stage === 'PICKING' ? 'neutral' : 'ok';
    return {
      seq: r.seq,
      vin: r.vin,
      vehicle: r.vehicle,
      seat: r.seatSpec,
      note,
      status,
      tone,
      need: mmss(Math.max(0, Math.round(r.needInSec - simElapsed))),
      hot: note !== '',
    };
  });

  const counts = board?.stageCounts || {};
  const anyHold = (board?.rows || []).some((r) => r.hold);
  const anyTuggerFault = (board?.rows || []).some((r) => r.tuggerFault);
  const stages = [
    { name: 'Pick', count: (counts.QUEUED || 0) + (counts.PICKING || 0), note: '', alert: false },
    { name: 'Sequence', count: counts.SEQUENCED || 0, note: anyHold ? 'on hold' : '', alert: anyHold },
    { name: 'Stage', count: counts.STAGED || 0, note: '', alert: false },
    { name: 'Tugger', count: counts.ON_TUGGER || 0, note: anyTuggerFault ? 'fault' : '', alert: anyTuggerFault },
    { name: 'Line-side', count: 0, note: '', alert: false },
  ];

  const fullLog = [...log, seedEntry(startedAt)];

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main menu">
        <div className="sidebar-brand">JIS Control Tower</div>
        {[['dashboard', 'Dashboard'], ['settings', 'Settings']].map(([id, label]) => (
          <button
            key={id}
            className={`nav-item${view === id ? ' active' : ''}`}
            aria-current={view === id ? 'page' : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
    <div className="page">
      <header className="header">
        <div className="header-title">
          <div className="eyebrow">Supplier Park · Seating sequence · Line 1 final assembly</div>
          <h1>JIS Control Tower</h1>
        </div>
        <div className="header-status">
          <span className="status-item"><i className="dot ok" />Build-order feed · rev {board ? board.rev : '—'}</span>
          <span className="status-item"><i className={`dot ${boardError ? 'crit' : 'ok'}`} />{boardError ? 'Systems unreachable' : '3 systems connected'}</span>
          {resetError && <span className="status-item"><i className="dot crit" />Reset failed: {resetError}</span>}
          <span className="status-item mono">{profile?.username || profile?.email || ''}</span>
          <button className="btn btn-ghost" onClick={handleLogout}>Sign out</button>
        </div>
      </header>

      {view === 'settings' ? (
        <section className="panel settings">
          <div className="panel-head">
            <h2>Settings</h2>
            <span className="mono muted">Changes apply to the dashboard immediately</span>
          </div>
          <label className="field">
            <span className="kpi-label">Cost of one line-stop minute (USD)</span>
            <input
              className="field-input mono"
              type="number"
              min="0"
              step="1000"
              value={costPerMin}
              onChange={(e) => updateCost(e.target.value === '' ? 0 : Math.max(0, Number(e.target.value)))}
            />
          </label>
          <div className="muted">
            Shown as {money(costPerMin)} on the dashboard.{' '}
            <button className="btn btn-ghost" onClick={() => updateCost(DEFAULT_COST_PER_MIN)}>Reset to {money(DEFAULT_COST_PER_MIN)}</button>
          </div>
        </section>
      ) : (
      <>
      <section className="kpis">
        <div className="kpi" style={{ borderTopColor: watch ? 'var(--amber)' : 'var(--teal)' }}>
          <div className="kpi-label">Tightest buffer to line-side need</div>
          <div className="kpi-value" style={{ color: watch ? 'var(--amber)' : 'var(--teal)' }}>{slackSec === null ? '—' : mmss(Math.max(0, Math.round(slackSec)))}</div>
          <div className="muted">
            Line-stop risk:{' '}
            <strong style={{ color: watch ? 'var(--amber)' : 'var(--teal)' }}>{watch ? 'Watch' : 'Low'}</strong>
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Seat sets in flight</div>
          <div className="kpi-value">{board ? board.rows.length : '—'}</div>
          <div className="muted">Next 2 hours of the build order</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Exceptions handled automatically</div>
          <div className="kpi-value">{handled}</div>
          <div className="muted">0 waiting on a person</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Event to action</div>
          <div className="kpi-value">{eventToAction === null ? '—' : `${eventToAction.toFixed(1)} s`}</div>
          <div className="muted">Cost of one line-stop minute: {money(costPerMin)}</div>
        </div>
      </section>

      <div className="main">
        <section className="panel board">
          <div className="panel-head">
            <h2>Sequence board</h2>
            <span className="mono muted">One row per vehicle, in build order</span>
          </div>
          <div className="scroll-x">
            <div className="board-grid">
              <div className="row row-head">
                <div>Seq</div><div>VIN</div><div>Vehicle</div><div>Seat set</div><div>Need in</div><div>Status</div>
              </div>
              {boardError && <div className="row"><div className="muted">Could not read the board from Vantiq: {boardError}</div></div>}
              {!boardError && !board && <div className="row"><div className="muted">Reading the systems of record…</div></div>}
              {rows.map((r) => (
                <div key={r.seq} className={`row${r.hot ? ' hot' : ''}`}>
                  <div className="mono muted">{r.seq}</div>
                  <div className="mono">{r.vin}</div>
                  <div>{r.vehicle}</div>
                  <div className="seat">
                    <span>{r.seat}</span>
                    {r.note && <span className="note">{r.note}</span>}
                  </div>
                  <div className="mono">{r.need}</div>
                  <div><span className={`chip chip-${r.tone}`}>{r.status}</span></div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className="side">
          {(Object.values(incidents).length > 0 || tuggerFault) && (
            <section className="panel pad">
              <div className="panel-head flush">
                <h2>Behind the scenes</h2>
                <span className="mono muted">Who does what</span>
              </div>
              {Object.values(incidents).map((inc) => (
                <div key={inc.vin} className="incident">
                  <div className="mono muted">Seq {inc.seq} · {inc.vin}</div>
                  {incidentSteps(inc).map((st, i) => (
                    <div key={i} className={`step${st.at ? ' done' : ''}${st.warn ? ' warn' : ''}`}>
                      <span className={`chip ${st.actor === 'Vantiq' ? 'chip-ok' : 'chip-info'}`}>{st.actor}</span>
                      <span className="step-text">{st.text}</span>
                      <span className="mono muted step-time">{st.at ? fmtTime(st.at) : 'waiting'}</span>
                    </div>
                  ))}
                </div>
              ))}
              {tuggerFault && (
                <div className="incident">
                  <div className="mono muted">Tugger {tuggerFault.tugger}</div>
                  {tuggerFaultSteps(tuggerFault).map((st, i) => (
                    <div key={i} className={`step${st.at ? ' done' : ''}${st.warn ? ' warn' : ''}`}>
                      <span className={`chip ${st.actor === 'Vantiq' ? 'chip-ok' : 'chip-info'}`}>{st.actor}</span>
                      <span className="step-text">{st.text}</span>
                      <span className="mono muted step-time">{st.at ? fmtTime(st.at) : 'waiting'}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="panel pad">
            <div className="panel-head flush">
              <h2>Park flow</h2>
              <span className="mono muted">Sets per stage</span>
            </div>
            <div className="stages">
              {stages.map((s) => (
                <div key={s.name} className={`stage${s.alert ? ' alert' : ''}`}>
                  <div className="stage-count">{s.count}</div>
                  <div className="stage-name">{s.name}</div>
                  <div className="stage-note">{s.note || ' '}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Event and action log</h2></div>
            <div className="log">
              {fullLog.map((e, i) => (
                <div key={`${e.t}-${i}`} className="log-item">
                  <div className="log-meta">
                    <span className="mono muted">{e.t}</span>
                    <span className={TAG_CLASS[e.tag]}>{e.tag}</span>
                  </div>
                  <div>{e.event}</div>
                  <div className="log-action"><span className="mono">→</span><span>{e.action}</span></div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <section className="panel pad sources">
        <div className="panel-head flush">
          <h2>Connected sources, one event model</h2>
          <span className="mono muted">No rip-and-replace of supplier systems</span>
        </div>
        <div className="source-row">
          {SOURCES.map((s) => (
            <div key={s.name} className="source">
              <strong>{s.name}</strong>
              <span className="mono proto">{s.proto}</span>
              <span className="muted">{s.detail}</span>
            </div>
          ))}
          <div className="source normalized">
            <strong>Normalized event</strong>
            <pre>{EVENT_SAMPLE}</pre>
          </div>
        </div>
      </section>
      </>
      )}

      <aside
        ref={drawerRef}
        className={`sim-drawer${drawerOpen ? ' open' : ''}${dragY !== null ? ' dragging' : ''}`}
        style={dragY !== null ? { transform: `translateY(${dragY}px)` } : undefined}
        aria-label="Simulation control"
      >
        <button
          ref={tabRef}
          className="sim-tab"
          style={tabLeft === null ? undefined : { left: tabLeft, right: 'auto' }}
          onPointerDown={onTabDown}
          onPointerMove={onTabMove}
          onPointerUp={onTabUp}
          onPointerCancel={onTabUp}
          onClick={onTabClick}
          onKeyDown={onTabKey}
          aria-expanded={drawerOpen}
          aria-controls="sim-panel"
          title="Click or pull up to open. Drag sideways to move the tab."
        >
          <span className="sim-tab-grip" aria-hidden="true" />
          Simulator
          <span className="sim-tab-state">{drawerOpen ? 'Close' : 'Open'}</span>
        </button>
        <div id="sim-panel" className="sim-panel">
          <div className="sim-inner">
            <div className="sim-title">
              <h2>Simulation control</h2>
              <span className="mono muted">Trigger a plant event</span>
              {simError && <span className="mono" style={{ color: 'var(--amber)' }}>Simulator not reachable at {SIM_URL}</span>}
            </div>
            <div className="sim-actions">
              <button
                className={`btn btn-info${flags.reorder ? ' on' : ''}`}
                onClick={() => fire('reorder', 'BUILD ORDER', 'Plant broadcast rev 118: seq 2046 and 2048 swapped (trim pull-forward).', 'Vantiq is re-prioritizing Supplier A\'s pick queue')}
              >
                Build-order change
              </button>
              <button
                className={`btn btn-act${flags.damage ? ' on' : ''}`}
                onClick={() => fire('damage', 'QUALITY', 'Vision check at SEQ-3 flagged a torn bolster on a seat set.', 'Supplier A holds that seat set. Vantiq is finding and reserving a replacement')}
              >
                Damaged seat at station
              </button>
              <button
                className={`btn btn-crit${flags.tugger ? ' on' : ''}`}
                onClick={() => fire('tugger', 'EQUIPMENT', 'Tugger T3 reported fault E-41 (drive) carrying sets for seq 2042 and 2043.', 'Reassigned both sets to T1, supervisor notified')}
              >
                Tugger fault
              </button>
              <button className="btn btn-ghost" onClick={reset}>Reset</button>
            </div>
          </div>
        </div>
      </aside>
    </div>
    </div>
  );
}
