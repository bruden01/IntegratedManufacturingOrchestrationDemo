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
            self.client.connect(host, port, keepalive=30)
            self.client.loop_start()

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
    def __init__(self, publisher, speed, opcua=None):
        self.pub = publisher
        self.opcua = opcua
        self.lock = threading.RLock()
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

    # ---- publishing --------------------------------------------------------

    def publish_build_order(self, reason, changes=None):
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
                stage = stage_for(v['need'])
                if stage != v['stage'] and v['need'] > 0:
                    v['stage'] = stage
                    self._publish_part_status(v)
                if v['need'] <= 0:
                    delivered.append(v)
            if delivered:
                for v in delivered:
                    self.vehicles.remove(v)
                    self.pub.post('PartStatus', {
                        'type': 'PartStatus', 'vin': v['vin'], 'seq': v['seq'], 'stage': 'LINE_SIDE',
                        'needInSec': 0, 'source': 'supplier-a', 'ts': now_iso(),
                    })
                    last = self.vehicles[-1]
                    self.vehicles.append(self._make_vehicle(last['seq'] + 1, last['need'] + TAKT_SEC))
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
        for v in (va, vb):
            v['stage'] = stage_for(v['need'])
        self.publish_build_order(
            reason='revision',
            changes=[
                {'seq': va['seq'], 'movedTo': b, 'note': 'pushed back'},
                {'seq': vb['seq'], 'movedTo': a, 'note': 'pulled forward'},
            ],
        )
        return {'rev': self.rev, 'swapped': [va['seq'], vb['seq']]}

    def _scenario_damage(self):
        """Vision check at the sequencing station flags a torn bolster."""
        v = self.vehicles[3]
        v['hold'] = True
        self.pub.post('Quality', {
            'type': 'QualityScan', 'result': 'FAIL', 'defect': 'torn bolster', 'station': 'SEQ-3',
            'vin': v['vin'], 'seq': v['seq'], 'source': 'supplier-a', 'ts': now_iso(),
        })
        self._publish_part_status(v)
        return {'seq': v['seq'], 'defect': 'torn bolster'}

    def _scenario_tugger(self):
        """Tugger T3 faults while carrying the two soonest seat sets."""
        t = self.tuggers['T3']
        carrying = sorted((v for v in self.vehicles if v['stage'] == 'ON_TUGGER'), key=lambda v: v['need'])[:2]
        for v in carrying:
            v['tugger'] = 'T3'
        t['state'] = 'FAULT'
        t['fault'] = 'E-41'
        self.pub.publish(f'{TOPIC_TUGGER}/T3/fault', {
            'type': 'TuggerFault', 'tugger': 'T3', 'code': 'E-41', 'description': 'drive fault',
            'carrying': [v['seq'] for v in carrying], 'source': 'supplier-b', 'ts': now_iso(),
        })
        self._publish_tugger(t)
        return {'tugger': 'T3', 'code': 'E-41', 'carrying': [v['seq'] for v in carrying]}

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
                'seatingPostErrors': self.pub.post_errors,
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
    ap.add_argument('--dry-run', action='store_true', help='print messages instead of publishing')
    args = ap.parse_args()

    pub = Publisher(args.broker, args.mqtt_port, args.dry_run)
    opcua = None
    if args.opcua_port:
        from opcua_server import MachineOpcUaServer
        opcua = MachineOpcUaServer(['CHG-1', 'CHG-2', 'CHG-3'], ['CONV-1'], args.opcua_port)
        opcua.start()
        print(f'OPC UA server: {opcua.endpoint}', flush=True)
    sim = Simulator(pub, args.speed, opcua)
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


if __name__ == '__main__':
    main()
