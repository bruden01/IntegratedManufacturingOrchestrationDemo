import { useEffect, useRef, useState } from 'react';
import Vantiq from './services/vantiq.js';
import { useAuth } from './contexts/AuthContext.jsx';
import {
  BASE_SLACK_SECONDS,
  DAMAGE_SLACK_COST,
  TUGGER_SLACK_COST,
  WATCH_THRESHOLD_SECONDS,
  EVENT_SAMPLE,
  SOURCES,
} from './data.js';

// Vantiq procedure that joins the plant MES, Supplier A and Supplier B systems into the board.
const BOARD_PROCEDURE = 'com.vantiqse.imo.Board.getSequenceBoard';
const BOARD_POLL_MS = 3000;
const STAGE_LABEL = { QUEUED: 'Queued', PICKING: 'Picking', SEQUENCED: 'Sequenced', STAGED: 'Staged', ON_TUGGER: 'On tugger' };

const SIM_URL = import.meta.env.VITE_SIM_URL || 'http://127.0.0.1:8765';
const SIDEBAR_WIDTH = 200;
const DEFAULT_COST_PER_MIN = 25000;
const money = (x) => `$${Number(x || 0).toLocaleString('en-US')}`;

const pad = (x) => String(x).padStart(2, '0');
const mmss = (sec) => `${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
const clock = (n) => {
  const s = 6 * 3600 + 42 * 60 + 10 + n * 9;
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};

const INITIAL_LOG = [
  {
    t: clock(0),
    tag: 'PLANT',
    event: 'Build-order rev 117 received. 40 vehicles in the next 2 hours.',
    action: 'Sequence calculated, picks released to Supplier A',
  },
];

const TAG_CLASS = {
  'BUILD ORDER': 'chip chip-info',
  QUALITY: 'chip chip-act',
  EQUIPMENT: 'chip chip-crit',
  PLANT: 'chip chip-neutral',
};

export default function App() {
  const [flags, setFlags] = useState({ reorder: false, damage: false, tugger: false });
  const [log, setLog] = useState([]);
  const [n, setN] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [view, setView] = useState('dashboard');
  const { profile, handleLogout } = useAuth();
  const [board, setBoard] = useState(null);
  const [boardError, setBoardError] = useState('');
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
    const load = () =>
      Vantiq.execute(BOARD_PROCEDURE)
        .then((b) => { if (!stopped) { setBoard(b); setBoardError(''); } })
        .catch((e) => { if (!stopped) setBoardError(e.message || 'Could not read the board from Vantiq'); });
    load();
    const id = setInterval(load, BOARD_POLL_MS);
    return () => { stopped = true; clearInterval(id); };
  }, []);

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
    setLog([{ t: clock(n + 1), tag, event, action }, ...log]);
    setN(n + 1);
  };

  const reset = () => {
    callSim('/reset');
    setFlags({ reorder: false, damage: false, tugger: false });
    setLog([]);
    setN(0);
  };

  const slackSec =
    BASE_SLACK_SECONDS - (flags.damage ? DAMAGE_SLACK_COST : 0) - (flags.tugger ? TUGGER_SLACK_COST : 0);
  const watch = slackSec < WATCH_THRESHOLD_SECONDS;
  const handled = Object.values(flags).filter(Boolean).length;

  const rows = (board?.rows || []).map((r) => {
    const faulted = r.tuggerFault ? `Tugger ${r.tugger} fault ${r.tuggerFault}` : '';
    const held = r.hold ? `Hold: ${r.defect || 'quality'}` : '';
    const note = [held, faulted].filter(Boolean).join(' · ');
    const status = r.hold ? 'Held' : STAGE_LABEL[r.stage] || r.stage;
    const tone = note ? 'act' : r.stage === 'QUEUED' || r.stage === 'PICKING' ? 'neutral' : 'ok';
    return {
      seq: r.seq,
      vin: r.vin,
      vehicle: r.vehicle,
      seat: r.seatSpec,
      note,
      status,
      tone,
      need: mmss(Math.max(0, Math.round(r.needInSec))),
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

  const fullLog = [...log, ...INITIAL_LOG];

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
          <div className="kpi-value" style={{ color: watch ? 'var(--amber)' : 'var(--teal)' }}>{mmss(slackSec)}</div>
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
          <div className="kpi-value">{n > 0 ? '1.8 s' : '—'}</div>
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
                onClick={() => fire('reorder', 'BUILD ORDER', 'Plant broadcast rev 118: seq 2046 and 2048 swapped (trim pull-forward).', 'Re-sequenced 2 seat sets, picks reprioritized at SEQ-2 in 1.8 s')}
              >
                Build-order change
              </button>
              <button
                className={`btn btn-act${flags.damage ? ' on' : ''}`}
                onClick={() => fire('damage', 'QUALITY', 'Vision check at SEQ-3 flagged a torn bolster on the seat set for seq 2044.', 'Reserved replacement from buffer B-14, re-slotted, line-side time held')}
              >
                Damaged seat at station
              </button>
              <button
                className={`btn btn-crit${flags.tugger ? ' on' : ''}`}
                onClick={() => fire('tugger', 'EQUIPMENT', 'Tugger T3 reported fault E-41 (drive) carrying sets for seq 2042 and 2043.', `Reassigned both sets to T1, supervisor notified, buffer cut to ${mmss(BASE_SLACK_SECONDS - (flags.damage ? DAMAGE_SLACK_COST : 0) - TUGGER_SLACK_COST)}`)}
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
