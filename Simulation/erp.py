"""The suppliers' and plant's own systems, as SQLite databases.

Plays the plant MES order database, Supplier A's seating ERP/WMS and Supplier B's fleet
management. The simulator keeps the rows current; Vantiq reads and writes them through the
JDBC connector. Schemas are in ../Databases/schema.
"""
import os
import sqlite3
import threading
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_DIR = os.path.join(HERE, '..', 'Databases', 'schema')
DEFAULT_DATA_DIR = os.path.join(HERE, '..', 'Databases', 'data')

# Spare seat sets held by Supplier A, one bin per seat spec. B-14 is the Cloth · Black bin the dashboard swaps from.
SPARE_BINS = [
    ('B-11', 'Vinyl · Black · Heated', 3),
    ('B-12', 'Cloth · Slate', 4),
    ('B-13', 'Vinyl · Tan · Heated', 2),
    ('B-14', 'Cloth · Black', 2),
    ('B-15', 'Vinyl · Black', 3),
    ('B-16', 'Cloth · Tan', 2),
]
TUGGER_REGISTRY = {'T1': ('Linde P60', 4), 'T2': ('Linde P60', 4), 'T3': ('Linde P60', 4)}
STAGE_BIN = {'PICKING': 'PICK-1', 'SEQUENCED': 'SEQ-3', 'STAGED': 'STAGE-2'}

DATABASES = {'plantmes': 'plantmes.db', 'supplier_a': 'supplier_a.db', 'supplier_b': 'supplier_b.db'}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class Erp:
    def __init__(self, data_dir=DEFAULT_DATA_DIR):
        self.data_dir = os.path.abspath(data_dir)
        os.makedirs(self.data_dir, exist_ok=True)
        self.lock = threading.RLock()
        self.errors = 0
        self.conns = {}
        for name, filename in DATABASES.items():
            # check_same_thread off: the simulator's loop and its HTTP handlers share these under self.lock.
            conn = sqlite3.connect(os.path.join(self.data_dir, filename), check_same_thread=False, timeout=10)
            conn.execute('PRAGMA journal_mode=WAL')   # lets the JDBC connector read while the simulator writes
            with open(os.path.join(SCHEMA_DIR, f'{name}.sql')) as f:
                conn.executescript(f.read())
            self.conns[name] = conn

    def path(self, name):
        return os.path.join(self.data_dir, DATABASES[name])

    def _run(self, name, fn):
        """Run a write; a locked or failing database must never stop the simulation."""
        with self.lock:
            try:
                with self.conns[name] as conn:
                    fn(conn)
            except sqlite3.Error as e:
                self.errors += 1
                if self.errors <= 3:
                    print(f'{name} database write failed: {e}', flush=True)

    # ---- full reset ---------------------------------------------------------

    def reset(self, rev, vehicles, tuggers):
        """Back to the healthy steady state: rebuild every table from the simulator's state."""
        ts = now_iso()

        def plantmes(c):
            c.execute('DELETE FROM build_orders')
            self._insert_orders(c, rev, vehicles, ts)

        def supplier_a(c):
            c.execute('DELETE FROM seat_sets')
            c.execute('DELETE FROM seat_inventory')
            c.execute('DELETE FROM pick_queue')
            c.executemany('INSERT INTO seat_inventory (bin, seat_spec, on_hand, reserved, updated_at) VALUES (?,?,?,0,?)',
                          [(b, spec, qty, ts) for b, spec, qty in SPARE_BINS])
            for v in vehicles:
                self._upsert_seat_set(c, v, ts)

        def supplier_b(c):
            c.execute('DELETE FROM assignments')
            c.execute('DELETE FROM tugger_requests')
            c.execute('DELETE FROM tuggers')
            c.executemany('INSERT INTO tuggers (id, model, capacity, state, fault_code, updated_at) VALUES (?,?,?,?,NULL,?)',
                          [(tid, m, cap, tuggers[tid]['state'], ts) for tid, (m, cap) in TUGGER_REGISTRY.items()])
            self._insert_assignments(c, vehicles, ts)

        self._run('plantmes', plantmes)
        self._run('supplier_a', supplier_a)
        self._run('supplier_b', supplier_b)

    # ---- plant MES ----------------------------------------------------------

    @staticmethod
    def _insert_orders(c, rev, vehicles, ts):
        c.executemany(
            'INSERT INTO build_orders (seq, vin, vehicle, seat_spec, rev, need_in_sec, updated_at) VALUES (?,?,?,?,?,?,?)',
            [(v['seq'], v['vin'], v['vehicle'], v['seat'], rev, round(v['need']), ts) for v in vehicles])

    def sync_build_orders(self, rev, vehicles):
        """The window advanced or the plant revised the order: publish the new snapshot."""
        ts = now_iso()

        def fn(c):
            c.execute('DELETE FROM build_orders')
            self._insert_orders(c, rev, vehicles, ts)
        self._run('plantmes', fn)

        def assignments(c):
            c.execute('DELETE FROM assignments')
            self._insert_assignments(c, vehicles, ts)
        self._run('supplier_b', assignments)

    # ---- Supplier A ---------------------------------------------------------

    @staticmethod
    def _upsert_seat_set(c, v, ts):
        c.execute(
            'INSERT INTO seat_sets (vin, seq, seat_spec, stage, hold, defect, updated_at) VALUES (?,?,?,?,?,?,?) '
            'ON CONFLICT(vin) DO UPDATE SET seq=excluded.seq, seat_spec=excluded.seat_spec, stage=excluded.stage, '
            'hold=excluded.hold, defect=excluded.defect, updated_at=excluded.updated_at',
            (v['vin'], v['seq'], v['seat'], v['stage'], 1 if v['hold'] else 0, v.get('defect'), ts))

    def update_seat_set(self, v):
        self._run('supplier_a', lambda c: self._upsert_seat_set(c, v, now_iso()))

    def reserved_bin(self, seat_spec):
        """Bin holding a spare reserved for this seat spec, or None. A reservation is the pick request."""
        with self.lock:
            try:
                row = self.conns['supplier_a'].execute(
                    'SELECT bin FROM seat_inventory WHERE seat_spec = ? AND reserved > 0 ORDER BY bin LIMIT 1',
                    (seat_spec,)).fetchone()
                return row[0] if row else None
            except sqlite3.Error:
                return None

    def consume_reserved(self, bin_id):
        """The picker takes the reserved spare out of the bin."""
        self._run('supplier_a', lambda c: c.execute(
            'UPDATE seat_inventory SET on_hand = on_hand - 1, reserved = reserved - 1, updated_at = ? '
            'WHERE bin = ? AND reserved > 0 AND on_hand > 0', (now_iso(), bin_id)))

    def requested_picks(self, rev):
        """Pick-queue rows Vantiq has asked for under this revision and Supplier A has not yet confirmed."""
        with self.lock:
            try:
                return self.conns['supplier_a'].execute(
                    "SELECT vin, seq, priority FROM pick_queue WHERE rev = ? AND state = 'REQUESTED' ORDER BY priority",
                    (rev,)).fetchall()
            except sqlite3.Error:
                return []

    def confirm_pick(self, vin):
        """Supplier A re-orders its picking to the requested priority and confirms."""
        self._run('supplier_a', lambda c: c.execute(
            "UPDATE pick_queue SET state = 'CONFIRMED', updated_at = ? WHERE vin = ?", (now_iso(), vin)))

    def delete_seat_set(self, vin):
        """A delivered seat set leaves the warehouse system's open records."""
        self._run('supplier_a', lambda c: c.execute('DELETE FROM seat_sets WHERE vin = ?', (vin,)))

    # ---- Supplier B ---------------------------------------------------------

    @staticmethod
    def _insert_assignments(c, vehicles, ts):
        c.executemany('INSERT INTO assignments (seq, tugger_id, updated_at) VALUES (?,?,?)',
                      [(v['seq'], v['tugger'], ts) for v in vehicles])

    def requested_tugger(self, vin):
        """Tugger Vantiq has asked Supplier B to carry this seat set on and Supplier B has not yet confirmed, or None."""
        with self.lock:
            try:
                row = self.conns['supplier_b'].execute(
                    "SELECT tugger_id FROM tugger_requests WHERE vin = ? AND state = 'REQUESTED'", (vin,)).fetchone()
                return row[0] if row else None
            except sqlite3.Error:
                return None

    def confirm_tugger(self, vin, seq, tugger_id):
        """Supplier B assigns the seat set to the requested tugger and confirms."""
        ts = now_iso()

        def fn(c):
            c.execute("UPDATE tugger_requests SET state = 'CONFIRMED', updated_at = ? WHERE vin = ?", (ts, vin))
            c.execute('INSERT INTO assignments (seq, tugger_id, updated_at) VALUES (?,?,?) '
                      'ON CONFLICT(seq) DO UPDATE SET tugger_id = excluded.tugger_id, updated_at = excluded.updated_at',
                      (seq, tugger_id, ts))
        self._run('supplier_b', fn)

    def update_tugger(self, tid, state, fault_code):
        self._run('supplier_b', lambda c: c.execute(
            'UPDATE tuggers SET state = ?, fault_code = ?, updated_at = ? WHERE id = ?', (state, fault_code, now_iso(), tid)))

    def close(self):
        for c in self.conns.values():
            c.close()
