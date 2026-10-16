"""JIS seating simulator.

Publishes the three plant feeds to MQTT and exposes a small HTTP control API so a
presenter can trigger demo scenarios. Reset returns everything to the healthy
steady state.

Feeds (all JSON):
  /vantiqse/imo/plantmes/buildorder             Plant MES build-order snapshots
  /vantiqse/imo/supplierb/tugger/<id>/telemetry Tugger position and load
  /vantiqse/imo/supplierb/tugger/<id>/fault     Tugger fault codes
Supplier A seating is REST, posted directly to the Vantiq service com.vantiqse.imo.Seating:
  PartStatus event                              Seat set stage changes
  Quality event                                 Vision-check results

Supplier B's machine data (tugger chargers, dock conveyor) is served over OPC UA
(opcua_server.py) for the Vantiq OPC UA extension source. It is separate from the MQTT
tugger fleet feed.

The simulator only reports what happened. The reaction (re-sequencing, replacement
picks, reassignment) is Vantiq's job.
"""
import argparse
import json
import os
import queue
import threading
import time
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOPIC_ROOT = '/vantiqse/imo'
TOPIC_BUILD_ORDER = f'{TOPIC_ROOT}/plantmes/buildorder'
SEATING_SERVICE = 'com.vantiqse.imo.Seating'
CONNECTOR_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'OpcUaConnector', 'serverConfig', 'server.config')
TOPIC_TUGGER = f'{TOPIC_ROOT}/supplierb/tugger'

FIRST_SEQ = 2041
WINDOW = 12            # vehicles in the published build-order window
TAKT_SEC = 180         # sim seconds between vehicles reaching line side
FIRST_NEED_SEC = 860   # sim seconds until the first vehicle is needed
TELEMETRY_SEC = 2      # sim seconds between tugger telemetry messages
TICK_SEC = 0.25        # real seconds per loop iteration
PICK_DELAY_SEC = 4.0   # real seconds from Vantiq reserving a spare to the picker taking it from the bin
REPLACEMENT_DELIVERY_DELAY_SEC = 10.0   # real seconds from the hold release to the tugger delivering the replacement
RELEASE_DELAY_SEC = 3.0   # real seconds from the pick to the supplier releasing the hold on the seat set
TUGGER_MOVE_DELAY_SEC = 5.0   # real seconds for Supplier B to move each load off a faulted tugger (one at a time)
TUGGER_REPLAN_DELAY_SEC = 6.0   # real seconds for Supplier B to swap the loads after a build-order change (long enough to talk through the request)
TUGGER_ASSIGN_DELAY_SEC = 2.0   # real seconds for Supplier B to assign the tugger Vantiq asked for
HOLD_DELAY_SEC = 3.0   # real seconds from a failed quality scan to the supplier's system holding the seat set

# (vehicle, seat) cycled to build the sequence; matches the dashboard mock.
MIX = [
    ('Traveler · Terra Gray', 'Vinyl · Black · Heated'),
    ('Terra · Moss', 'Cloth · Slate'),
    ('Traveler · Sand', 'Vinyl · Tan · Heated'),
    ('Terra · Terra Gray', 'Cloth · Black'),
    ('Traveler · Moss', 'Vinyl · Black'),
    ('Terra · Sand', 'Cloth · Tan'),
    ('Traveler · Slate', 'Vinyl · Black · Heated'),
    ('Terra · Moss', 'Cloth · Slate'),
]

# Stage by seconds until needed at line side (upper bound of each stage).
STAGES = [('ON_TUGGER', 1100), ('STAGED', 1400), ('SEQUENCED', 1700), ('PICKING', 1900), ('QUEUED', float('inf'))]
TUGGER_IDS = ['T1', 'T2', 'T3']
# Which tugger carries a vehicle by default: pairs of vehicles, T3 second in the cycle.
TUGGER_CYCLE = ['T1', 'T3', 'T2']


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def stage_for(need):
    return next(name for name, upper in STAGES if need <= upper)


STAGE_ORDER = [name for name, _ in reversed(STAGES)]   # earliest stage first


def held_stage(v):
    """A seat set's stage: by its need time, unless a build-order change pins it. A pin held `until confirm` keeps the
    stage until Supplier A accepts the new pick order; any other pin stops a set falling back to an earlier stage."""
    natural = stage_for(v['need'])
    pin = v.get('pin')
    if pin is None:
        return natural
    if v.get('pin_wait'):
        return pin
    if STAGE_ORDER.index(natural) >= STAGE_ORDER.index(pin):
        v.pop('pin')
        return natural
    return pin


def load_vantiq_token():
    """Token from VANTIQ_TOKEN, else the authToken in the OPC UA connector's server.config."""
    if os.environ.get('VANTIQ_TOKEN'):
        return os.environ['VANTIQ_TOKEN']
    try:
        with open(CONNECTOR_CONFIG) as f:
            for line in f:
                key, _, value = line.partition('=')
                if key.strip() == 'authToken' and value.strip():
                    return value.strip()
    except OSError:
        pass
    return None


class Publisher:
    """Publishes to MQTT and posts REST events to Vantiq, or prints when running dry."""

    def __init__(self, host, port, dry_run, vantiq_url='https://dev.vantiq.com'):
        self.dry_run = dry_run
        self.count = 0
        self.client = None
        self.vantiq_url = vantiq_url.rstrip('/')
        self.token = None if dry_run else load_vantiq_token()
        self.post_errors = 0
        if not dry_run and not self.token:
            print('No Vantiq token (set VANTIQ_TOKEN or OpcUaConnector/serverConfig/server.config): Seating events will not be sent', flush=True)
        self.posts = queue.Queue()
        threading.Thread(target=self._post_worker, daemon=True).start()
        if not dry_run:
            import paho.mqtt.client as mqtt
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f'imo-sim-{int(time.time())}')
            self.mqtt_connected = False
            self.client.on_connect = self._on_connect
            self.client.on_disconnect = self._on_disconnect
            # Bounded, so a long broker outage cannot grow the queue without limit.
            self.client.max_queued_messages_set(1000)
            # A broker that is down must not stop the REST, OPC UA and database feeds: connect in the background
            # and let paho keep retrying.
            self.client.connect_async(host, port, keepalive=30)
            self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        self.mqtt_connected = not reason_code.is_failure
        print(f'MQTT broker: {"connected" if self.mqtt_connected else f"refused ({reason_code})"}', flush=True)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        if self.mqtt_connected:
            print('MQTT broker: disconnected, retrying', flush=True)
        self.mqtt_connected = False

    def publish(self, topic, payload):
        self.count += 1
        body = json.dumps(payload)
        if self.dry_run:
            print(f'{topic} {body}', flush=True)
        else:
            self.client.publish(topic, body, qos=1)

    def post(self, event, payload):
        """POST an event to a Seating service event type. Queued so the simulation never blocks on the network."""
        self.count += 1
        if self.dry_run:
            print(f'POST {SEATING_SERVICE}/{event} {json.dumps(payload)}', flush=True)
        elif self.token:
            self.posts.put((event, payload))

    def _post_worker(self):
        while True:
            event, payload = self.posts.get()
            req = urllib.request.Request(
                f'{self.vantiq_url}/api/v1/resources/services/{SEATING_SERVICE}/{event}',
                data=json.dumps(payload).encode(),
                headers={'Authorization': f'Bearer {self.token}', 'Content-Type': 'application/json'},
                method='POST')
            try:
                urllib.request.urlopen(req, timeout=10).read()
            except Exception as e:
                self.post_errors += 1
                if self.post_errors <= 3:
                    print(f'Seating POST {event} failed: {e}', flush=True)

    def close(self):
        if self.client:
            self.client.loop_stop()
            self.client.disconnect()


class Simulator:
    def __init__(self, publisher, speed, opcua=None, erp=None, hold_delay=HOLD_DELAY_SEC, pick_delay=PICK_DELAY_SEC):
        self.pub = publisher
        self.hold_delay = hold_delay
        self.pick_delay = pick_delay
        self.opcua = opcua
        self.erp = erp
        self.lock = threading.RLock()
        self.pick_confirm = threading.Event()   # set when the presenter, playing Supplier A, confirms the new pick order
        self.speed = speed
        self.paused = False
        self.reset()

    # ---- state -------------------------------------------------------------

    def _make_vehicle(self, seq, need):
        vehicle, seat = MIX[(seq - FIRST_SEQ) % len(MIX)]
        return {
            'seq': seq,
            'vin': f'SIM7K{1042 + seq - FIRST_SEQ}',
            'vehicle': vehicle,
            'seat': seat,
            'need': float(need),
            'stage': stage_for(need),
            'tugger': TUGGER_CYCLE[((seq - FIRST_SEQ + 1) // 2) % 3],
            'hold': False,
        }

    def reset(self):
        """Back to the healthy steady state."""
        with self.lock:
            self.epoch = getattr(self, 'epoch', 0) + 1   # a reset drops any hold still waiting to land
            self.pick_confirm.clear()
            self.rev = 117
            self.vehicles = [self._make_vehicle(FIRST_SEQ + i, FIRST_NEED_SEC + i * TAKT_SEC) for i in range(WINDOW)]
            self.tuggers = {
                tid: {'id': tid, 'state': 'MOVING', 'phase': i / len(TUGGER_IDS), 'fault': None}
                for i, tid in enumerate(TUGGER_IDS)
            }
            self.sim_time = 0.0
            self._telemetry_acc = 0.0
            self.scenarios = []
            self.machine_faults = {}   # machine id -> fault code, for the OPC UA feed
            self.publish_build_order(reason='reset' if hasattr(self, 'booted') else 'startup')
            self.booted = True
            for v in self.vehicles:
                self._publish_part_status(v)
            self._update_opcua()
            if self.erp:
                self.erp.reset(self.rev, self.vehicles, self.tuggers)

    # ---- publishing --------------------------------------------------------

    def publish_build_order(self, reason, changes=None):
        if self.erp and hasattr(self, 'booted'):
            self.erp.sync_build_orders(self.rev, self.vehicles)
        self.pub.publish(TOPIC_BUILD_ORDER, {
            'type': 'BuildOrder',
            'rev': self.rev,
            'reason': reason,
            'ts': now_iso(),
            'changes': changes or [],
            'vehicles': [
                {'seq': v['seq'], 'vin': v['vin'], 'vehicle': v['vehicle'], 'seat': v['seat'], 'needInSec': round(v['need'])}
                for v in self.vehicles
            ],
        })

    def _publish_part_status(self, v):
        if self.erp:
            self.erp.update_seat_set(v)
        self.pub.post('PartStatus', {
            'type': 'PartStatus',
            'vin': v['vin'],
            'seq': v['seq'],
            'stage': 'HOLD' if v['hold'] else v['stage'],
            'station': {'PICKING': 'PICK-1', 'SEQUENCED': 'SEQ-3', 'STAGED': 'STAGE-2', 'ON_TUGGER': v['tugger']}.get(v['stage']),
            'tugger': v['tugger'] if v['stage'] == 'ON_TUGGER' else None,
            'needInSec': round(v['need']),
            'source': 'supplier-a',
            'ts': now_iso(),
        })

    def _publish_tugger(self, t):
        # Position runs a loop dock -> line -> dock. Frozen while faulted.
        pos = t['phase'] % 1.0
        carrying = [v['seq'] for v in self.vehicles if v['stage'] == 'ON_TUGGER' and v['tugger'] == t['id']]
        self.pub.publish(f"{TOPIC_TUGGER}/{t['id']}/telemetry", {
            'type': 'TuggerTelemetry',
            'tugger': t['id'],
            'state': t['state'],
            'position': round(pos, 3),
            'zone': 'DOCK' if pos < 0.1 else 'LINE_SIDE' if 0.45 < pos < 0.55 else 'TRANSIT',
            'speedMps': 0.0 if t['state'] == 'FAULT' else 1.2,
            'carrying': carrying,
            'battery': max(20, round(95 - self.sim_time / 120)),
            'source': 'supplier-b',
            'ts': now_iso(),
        })

    def _update_opcua(self):
        """Push machine state: one charger per tugger, plus the dock conveyor."""
        if not self.opcua:
            return
        for i, tid in enumerate(TUGGER_IDS, start=1):
            t = self.tuggers[tid]
            docked = (t['phase'] % 1.0) < 0.1
            fault = self.machine_faults.get(f'CHG-{i}', '')
            self.opcua.update(f'CHG-{i}', {
                'State': 'FAULT' if fault else 'CHARGING' if docked and t['state'] != 'FAULT' else 'IDLE',
                'ChargePct': max(20, round(95 - self.sim_time / 120)),
                'FaultCode': fault,
            })
        fault = self.machine_faults.get('CONV-1', '')
        self.opcua.update('CONV-1', {
            'State': 'JAMMED' if fault else 'RUNNING',
            'CartCount': sum(1 for v in self.vehicles if v['stage'] in ('STAGED', 'SEQUENCED')),
            'FaultCode': fault,
        })

    # ---- time --------------------------------------------------------------

    def step(self, real_dt):
        with self.lock:
            if self.paused:
                return
            dt = real_dt * self.speed
            self.sim_time += dt

            for t in self.tuggers.values():
                if t['state'] == 'MOVING':
                    t['phase'] += dt / 240.0

            delivered = []
            for v in self.vehicles:
                v['need'] -= dt
                stage = held_stage(v)
                if stage != v['stage'] and v['need'] > 0:
                    v['stage'] = stage
                    self._publish_part_status(v)
                if v['need'] <= 0:
                    delivered.append(v)
            if delivered:
                for v in delivered:
                    self.vehicles.remove(v)
                    if self.erp:
                        self.erp.delete_seat_set(v['vin'])
                    self.pub.post('PartStatus', {
                        'type': 'PartStatus', 'vin': v['vin'], 'seq': v['seq'], 'stage': 'LINE_SIDE',
                        'needInSec': 0, 'source': 'supplier-a', 'ts': now_iso(),
                    })
                    last = self.vehicles[-1]
                    entering = self._make_vehicle(last['seq'] + 1, last['need'] + TAKT_SEC)
                    if self.tuggers[entering['tugger']]['state'] == 'FAULT':
                        # The fleet system does not schedule a faulted tugger.
                        entering['tugger'] = next(t['id'] for t in self.tuggers.values() if t['state'] != 'FAULT')
                    self.vehicles.append(entering)
                    if self.erp:
                        self.erp.update_seat_set(entering)
                self.publish_build_order(reason='advance')

            self._telemetry_acc += dt
            if self._telemetry_acc >= TELEMETRY_SEC:
                self._telemetry_acc = 0.0
                for t in self.tuggers.values():
                    self._publish_tugger(t)
                self._update_opcua()

    # ---- scenarios ---------------------------------------------------------

    def trigger(self, name):
        with self.lock:
            handler = {
                'reorder': self._scenario_reorder,
                'damage': self._scenario_damage,
                'tugger': self._scenario_tugger,
                'charger': self._scenario_charger,
                'conveyor': self._scenario_conveyor,
            }.get(name)
            if handler is None:
                raise KeyError(name)
            result = handler()
            self.scenarios.append(name)
            return result

    def _scenario_reorder(self):
        """Plant pulls a later vehicle forward: build-order rev 118 swaps two positions."""
        a, b = 5, 7
        va, vb = self.vehicles[a], self.vehicles[b]
        # Swap the vehicles but keep each slot's need time (the slot is what the line waits on).
        va['need'], vb['need'] = vb['need'], va['need']
        self.vehicles[a], self.vehicles[b] = vb, va
        self.rev += 1
        # Nothing is picked differently until Supplier A accepts. The pulled-forward set stays where it was until
        # then; the pushed-back set keeps the stage it has already reached (a set being picked does not un-pick).
        vb['pin'], vb['pin_wait'] = vb['stage'], True
        va['pin'] = va['stage']
        for v in (va, vb):
            v['stage'] = held_stage(v)
            if self.erp:
                self.erp.update_seat_set(v)
        self.publish_build_order(
            reason='revision',
            changes=[
                {'seq': va['seq'], 'movedTo': b, 'note': 'pushed back'},
                {'seq': vb['seq'], 'movedTo': a, 'note': 'pulled forward'},
            ],
        )
        self.pick_confirm.clear()
        if self.erp:
            threading.Thread(target=self._pick_queue_worker, args=(self.rev, self.epoch), daemon=True).start()
        return {'rev': self.rev, 'swapped': [va['seq'], vb['seq']]}

    def _pick_queue_worker(self, rev, epoch):
        """Supplier A's warehouse system. Vantiq writes the new pick order into pick_queue; Supplier A sees the
        request, then waits for a person at Supplier A to commit that the new order can be picked. The presenter plays
        that person and presses Confirm; until then the change is only a request and the buffer stays reduced."""
        deadline = time.time() + 60
        rows = []
        while time.time() < deadline and not rows:
            if epoch != self.epoch:
                return
            rows = self.erp.requested_picks(rev)
            if not rows:
                time.sleep(0.5)
        while not self.pick_confirm.wait(0.5):
            if epoch != self.epoch:
                return
        for vin, seq, priority in rows:
            with self.lock:
                if epoch != self.epoch:
                    return
                self.erp.confirm_pick(vin)
                v = next((x for x in self.vehicles if x['vin'] == vin), None)
                if v and v.pop('pin_wait', False):
                    v.pop('pin', None)
                    stage = held_stage(v)
                    if stage != v['stage']:
                        v['stage'] = stage
                        self._publish_part_status(v)
                self.pub.post('PartStatus', {
                    'type': 'PartStatus', 'vin': vin, 'seq': seq, 'stage': 'PICK_QUEUE_CONFIRMED',
                    'priority': priority, 'rev': rev, 'source': 'supplier-a', 'ts': now_iso(),
                })
        threading.Thread(target=self._tugger_replan_worker, args=(epoch,), daemon=True).start()

    def _tugger_replan_worker(self, epoch):
        """Supplier B's fleet system, after a build-order change. Vantiq writes the swap of the two loads into
        tugger_requests; Supplier B sees it, swaps them after a pause, and reports that it has."""
        deadline = time.time() + 30
        rows = []
        while time.time() < deadline and not rows:
            if epoch != self.epoch:
                return
            rows = self.erp.requested_replans()
            if not rows:
                time.sleep(0.5)
        if not rows:
            return
        time.sleep(TUGGER_REPLAN_DELAY_SEC)
        moved = []
        with self.lock:
            if epoch != self.epoch:
                return
            for vin, seq, to, frm in rows:
                for v in self.vehicles:
                    if v['vin'] == vin:
                        v['tugger'] = to
                self.erp.confirm_tugger(vin, seq, to)
                moved.append({'seq': seq, 'vin': vin, 'fromTugger': frm, 'toTugger': to})
            self.pub.publish(f'{TOPIC_TUGGER}/{rows[0][3]}/fault', {
                'type': 'TuggerReassigned', 'reason': 'BUILD_ORDER', 'tugger': rows[0][3], 'moved': moved,
                'source': 'supplier-b', 'ts': now_iso(),
            })

    def _scenario_damage(self):
        """Vision check at the sequencing station flags a torn bolster.

        The failed scan is reported at once. A few seconds later the supplier's own system reacts and
        holds the seat set: only then do the hold and its PartStatus appear.
        """
        v = self.vehicles[3]
        self.pub.post('Quality', {
            'type': 'QualityScan', 'result': 'FAIL', 'defect': 'torn bolster', 'station': 'SEQ-3',
            'vin': v['vin'], 'seq': v['seq'], 'source': 'supplier-a', 'ts': now_iso(),
        })
        epoch = self.epoch
        timer = threading.Timer(self.hold_delay, self._apply_hold, args=(v, 'torn bolster', epoch))
        timer.daemon = True
        timer.start()
        return {'seq': v['seq'], 'defect': 'torn bolster', 'holdInSec': self.hold_delay}

    def _apply_hold(self, v, defect, epoch):
        """The supplier's system places the hold: update its record and report the new status."""
        with self.lock:
            if epoch != self.epoch or v not in self.vehicles:
                return   # reset, or the seat set already reached the line
            v['hold'] = True
            v['defect'] = defect
            self._publish_part_status(v)
        threading.Thread(target=self._picker, args=(v, epoch), daemon=True).start()

    def _picker(self, v, epoch):
        """The warehouse picker. A reserved spare is the pick request: the picker takes the spare from its bin,
        then the supplier releases the hold and the replacement carries on as the seat set."""
        deadline = time.time() + 120
        bin_id = None
        while time.time() < deadline and bin_id is None:
            if epoch != self.epoch:
                return
            bin_id = self.erp.reserved_bin(v['seat']) if self.erp else None
            if bin_id is None:
                time.sleep(0.5)
        if bin_id is None:
            return   # Vantiq never reserved a spare
        time.sleep(self.pick_delay)
        with self.lock:
            if epoch != self.epoch or v not in self.vehicles:
                return
            self.erp.consume_reserved(bin_id)
            self._post_replacement(v, 'REPLACEMENT_PICKED', bin_id)
        # Supplier B's fleet system: Vantiq asks for a tugger, Supplier B assigns it. The hold stays until it has.
        tugger_id = None
        deadline = time.time() + 60
        while time.time() < deadline and tugger_id is None and self.erp:
            if epoch != self.epoch:
                return
            tugger_id = self.erp.requested_tugger(v['vin'])
            if tugger_id is None:
                time.sleep(0.5)
        if tugger_id:
            time.sleep(TUGGER_ASSIGN_DELAY_SEC)
            with self.lock:
                if epoch != self.epoch or v not in self.vehicles:
                    return
                v['tugger'] = tugger_id
                self.erp.confirm_tugger(v['vin'], v['seq'], tugger_id)
                self.pub.post('PartStatus', {
                    'type': 'PartStatus', 'vin': v['vin'], 'seq': v['seq'], 'stage': 'TUGGER_ASSIGNED',
                    'tugger': tugger_id, 'bin': bin_id, 'source': 'supplier-b', 'ts': now_iso(),
                })
        time.sleep(RELEASE_DELAY_SEC)
        with self.lock:
            if epoch != self.epoch or v not in self.vehicles:
                return
            v['hold'] = False
            v['defect'] = None
            if self.erp:
                self.erp.update_seat_set(v)
            self._post_replacement(v, 'HOLD_RELEASED', bin_id)
        # The replacement is still in the warehouse until Supplier B's tugger brings it: the seat set only counts
        # as delivered, and the buffer only recovers, when it arrives.
        time.sleep(REPLACEMENT_DELIVERY_DELAY_SEC)
        with self.lock:
            if epoch != self.epoch or v not in self.vehicles:
                return
            tugger = tugger_id or v['tugger']
            v['tugger'] = tugger
            v['pin'] = 'ON_TUGGER'   # the set is on its tugger from here, whatever its need time says
            v['stage'] = held_stage(v)
            self.erp.deliver_replacement(v['vin'])
            self._publish_part_status(v)
            self.pub.post('PartStatus', {
                'type': 'PartStatus', 'vin': v['vin'], 'seq': v['seq'], 'stage': 'REPLACEMENT_DELIVERED',
                'tugger': tugger, 'bin': bin_id, 'source': 'supplier-b', 'ts': now_iso(),
            })

    def _post_replacement(self, v, stage, bin_id):
        self.pub.post('PartStatus', {
            'type': 'PartStatus', 'vin': v['vin'], 'seq': v['seq'], 'stage': stage, 'bin': bin_id,
            'needInSec': round(v['need']), 'source': 'supplier-a', 'ts': now_iso(),
        })

    def _scenario_tugger(self):
        """Tugger T3 faults while carrying the two soonest seat sets."""
        t = self.tuggers['T3']
        carrying = sorted((v for v in self.vehicles if v['stage'] == 'ON_TUGGER'), key=lambda v: v['need'])[:2]
        for v in carrying:
            v['tugger'] = 'T3'
        t['state'] = 'FAULT'
        t['fault'] = 'E-41'
        if self.erp:
            self.erp.update_tugger('T3', 'FAULT', 'E-41')
            self.erp.sync_build_orders(self.rev, self.vehicles)
        self.pub.publish(f'{TOPIC_TUGGER}/T3/fault', {
            'type': 'TuggerFault', 'tugger': 'T3', 'code': 'E-41', 'description': 'drive fault',
            'carrying': [v['seq'] for v in carrying], 'source': 'supplier-b', 'ts': now_iso(),
        })
        self._publish_tugger(t)
        if self.erp:
            threading.Thread(target=self._tugger_move_worker, args=(self.epoch,), daemon=True).start()
        return {'tugger': 'T3', 'code': 'E-41', 'carrying': [v['seq'] for v in carrying]}

    def _tugger_move_worker(self, epoch):
        """Supplier B's fleet system. Vantiq writes the moves off the faulted tugger into tugger_requests; Supplier B
        sees them, moves the loads, and reports that it has."""
        deadline = time.time() + 60
        rows = []
        while time.time() < deadline and not rows:
            if epoch != self.epoch:
                return
            rows = self.erp.requested_moves()
            if not rows:
                time.sleep(0.5)
        if not rows:
            return
        # Supplier B moves one load at a time, so the dashboard shows each set changing tugger in turn.
        for vin, seq, to, frm in rows:
            time.sleep(TUGGER_MOVE_DELAY_SEC)
            with self.lock:
                if epoch != self.epoch:
                    return
                for v in self.vehicles:
                    if v['vin'] == vin:
                        v['tugger'] = to
                self.erp.confirm_tugger(vin, seq, to)
                self.pub.publish(f'{TOPIC_TUGGER}/{frm}/fault', {
                    'type': 'TuggerReassigned', 'tugger': frm,
                    'moved': [{'seq': seq, 'vin': vin, 'fromTugger': frm, 'toTugger': to}],
                    'source': 'supplier-b', 'ts': now_iso(),
                })

    def _scenario_charger(self):
        """Charging station CHG-2 trips a contactor fault (OPC UA machine data only)."""
        self.machine_faults['CHG-2'] = 'E-17'
        self._update_opcua()
        return {'machine': 'CHG-2', 'code': 'E-17', 'description': 'contactor fault'}

    def _scenario_conveyor(self):
        """Dock conveyor CONV-1 jams (OPC UA machine data only)."""
        self.machine_faults['CONV-1'] = 'J-03'
        self._update_opcua()
        return {'machine': 'CONV-1', 'code': 'J-03', 'description': 'cart jam'}

    # ---- status ------------------------------------------------------------

    def status(self):
        with self.lock:
            return {
                'rev': self.rev,
                'speed': self.speed,
                'paused': self.paused,
                'simTimeSec': round(self.sim_time),
                'messagesPublished': self.pub.count,
                'scenariosTriggered': list(self.scenarios),
                'dryRun': self.pub.dry_run,
                'mqttConnected': None if self.pub.dry_run else self.pub.mqtt_connected,
                'seatingPostErrors': self.pub.post_errors,
                'databaseWriteErrors': self.erp.errors if self.erp else None,
                'machineFaults': dict(self.machine_faults),
                'tuggers': {k: {'state': t['state'], 'fault': t['fault']} for k, t in self.tuggers.items()},
                'vehicles': [
                    {'seq': v['seq'], 'stage': 'HOLD' if v['hold'] else v['stage'], 'needInSec': round(v['need'])}
                    for v in self.vehicles[:8]
                ],
            }


CONTROL_PAGE = """<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IMO Simulator</title>
<style>
  body { font: 15px system-ui; background: #0f1418; color: #e6ebee; max-width: 640px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 22px; } .row { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
  button { font: inherit; padding: 10px 16px; border-radius: 6px; border: 1px solid #26313a; background: #161d23; color: inherit; cursor: pointer; }
  button:hover { border-color: #f2a93b; } .reset { border-color: #3fb8a5; }
  pre { background: #161d23; padding: 12px; border-radius: 6px; overflow: auto; font-size: 13px; }
</style>
<h1>IMO Simulator</h1>
<div class="row">
  <button onclick="send('/scenario/reorder')">Build-order change</button>
  <button onclick="send('/supplier/confirm-pick')">Supplier A confirms pick order</button>
  <button onclick="send('/scenario/damage')">Damaged seat</button>
  <button onclick="send('/scenario/tugger')">Tugger fault</button>
  <button onclick="send('/scenario/charger')">Charger fault</button>
  <button onclick="send('/scenario/conveyor')">Conveyor jam</button>
  <button class="reset" onclick="send('/reset')">Reset</button>
</div>
<div class="row">
  Speed: <button onclick="send('/speed?factor=1')">1x</button><button onclick="send('/speed?factor=5')">5x</button>
  <button onclick="send('/speed?factor=10')">10x</button>
  <button onclick="send('/pause')">Pause</button><button onclick="send('/resume')">Resume</button>
</div>
<pre id="out">loading…</pre>
<script>
  async function send(p) { await fetch(p, { method: 'POST' }); refresh(); }
  async function refresh() { const r = await fetch('/status'); document.getElementById('out').textContent = JSON.stringify(await r.json(), null, 2); }
  refresh(); setInterval(refresh, 1500);
</script>
"""


def make_handler(sim):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body, ctype='application/json'):
            data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.end_headers()

        def do_GET(self):
            path = self.path.split('?')[0]
            if path == '/':
                self._send(200, CONTROL_PAGE, 'text/html; charset=utf-8')
            elif path == '/status':
                self._send(200, sim.status())
            else:
                self._send(404, {'error': 'not found'})

        def do_POST(self):
            path, _, query = self.path.partition('?')
            if path == '/reset':
                sim.reset()
                self._send(200, {'ok': True, 'state': 'steady'})
            elif path.startswith('/scenario/'):
                try:
                    self._send(200, {'ok': True, **sim.trigger(path.rsplit('/', 1)[1])})
                except KeyError:
                    self._send(404, {'error': 'unknown scenario', 'available': ['reorder', 'damage', 'tugger', 'charger', 'conveyor']})
            elif path == '/supplier/confirm-pick':
                sim.pick_confirm.set()
                self._send(200, {'ok': True})
            elif path == '/speed':
                try:
                    factor = float(dict(p.split('=') for p in query.split('&') if '=' in p).get('factor', ''))
                    if not 0.1 <= factor <= 60:
                        raise ValueError
                except ValueError:
                    self._send(400, {'error': 'factor must be a number from 0.1 to 60'})
                    return
                sim.speed = factor
                self._send(200, {'ok': True, 'speed': factor})
            elif path in ('/pause', '/resume'):
                sim.paused = path == '/pause'
                self._send(200, {'ok': True, 'paused': sim.paused})
            else:
                self._send(404, {'error': 'not found'})

        def log_message(self, fmt, *args):
            pass

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--broker', default='public.vantiq.com')
    ap.add_argument('--mqtt-port', type=int, default=1883)
    ap.add_argument('--http-port', type=int, default=8765)
    ap.add_argument('--speed', type=float, default=1.0, help='sim seconds per real second')
    ap.add_argument('--opcua-port', type=int, default=4840, help='OPC UA server port (0 disables)')
    ap.add_argument('--db-dir', default=None, help='where the SQLite system-of-record files live (default ../Databases/data)')
    ap.add_argument('--no-db', action='store_true', help='do not maintain the SQLite databases')
    ap.add_argument('--pick-delay', type=float, default=PICK_DELAY_SEC, help='real seconds between Vantiq reserving a spare and the picker taking it')
    ap.add_argument('--hold-delay', type=float, default=HOLD_DELAY_SEC, help='real seconds between a failed quality scan and the hold')
    ap.add_argument('--dry-run', action='store_true', help='print messages instead of publishing')
    args = ap.parse_args()

    pub = Publisher(args.broker, args.mqtt_port, args.dry_run)
    opcua = None
    if args.opcua_port:
        from opcua_server import MachineOpcUaServer
        opcua = MachineOpcUaServer(['CHG-1', 'CHG-2', 'CHG-3'], ['CONV-1'], args.opcua_port)
        opcua.start()
        print(f'OPC UA server: {opcua.endpoint}', flush=True)
    erp = None
    if not args.no_db:
        from erp import Erp, DEFAULT_DATA_DIR
        erp = Erp(args.db_dir or DEFAULT_DATA_DIR)
        print(f'System databases: {erp.data_dir}', flush=True)
    sim = Simulator(pub, args.speed, opcua, erp, args.hold_delay, args.pick_delay)
    server = ThreadingHTTPServer(('127.0.0.1', args.http_port), make_handler(sim))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f'Control panel: http://127.0.0.1:{args.http_port}/  ({"dry run" if args.dry_run else f"publishing to {args.broker}:{args.mqtt_port}"})', flush=True)

    try:
        last = time.monotonic()
        while True:
            time.sleep(TICK_SEC)
            t = time.monotonic()
            sim.step(t - last)
            last = t
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        pub.close()
        if opcua:
            opcua.stop()
        if erp:
            erp.close()


if __name__ == '__main__':
    main()
