"""OPC UA server for Supplier B's machine data.

Exposes the equipment at the supplier park as nodes the Vantiq OPC UA extension source
can subscribe to. This is separate from the tugger fleet, which is MQTT. Runs its own
asyncio loop on a background thread; the simulator pushes values in with `update`.

Address space (namespace URI `urn:vantiqse:imo`, string node ids `Machine.<id>.<field>`):
  Charger CHG-1..CHG-3 (tugger charging stations)
    State       IDLE | CHARGING | FAULT
    ChargePct   percent charge of the docked tugger
    FaultCode   "" when healthy
  Conveyor CONV-1 (dock conveyor)
    State       RUNNING | STOPPED | JAMMED
    CartCount   carts on the conveyor
    FaultCode   "" when healthy
"""
import asyncio
import logging
import threading

from asyncua import Server, ua

NAMESPACE_URI = 'urn:vantiqse:imo'
STR, DBL, INT = ua.VariantType.String, ua.VariantType.Double, ua.VariantType.Int32
CHARGER_FIELDS = {'State': ('IDLE', STR), 'ChargePct': (100, INT), 'FaultCode': ('', STR)}
CONVEYOR_FIELDS = {'State': ('RUNNING', STR), 'CartCount': (0, INT), 'FaultCode': ('', STR)}


class MachineOpcUaServer:
    def __init__(self, charger_ids, conveyor_ids, port, host='0.0.0.0'):
        self.machines = {m: CHARGER_FIELDS for m in charger_ids}
        self.machines.update({m: CONVEYOR_FIELDS for m in conveyor_ids})
        self.port = port
        self.host = host
        self.loop = asyncio.new_event_loop()
        self.nodes = {}
        self.last = {}
        self._ready = threading.Event()
        self._error = None
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()
        self._ready.wait(timeout=15)
        if self._error:
            raise self._error

    def stop(self):
        if self._thread.is_alive():
            self.loop.call_soon_threadsafe(self.loop.stop)

    @property
    def endpoint(self):
        return f'opc.tcp://localhost:{self.port}/imo'

    def update(self, machine_id, values):
        """Write changed values. Safe to call from any thread."""
        if not self._ready.is_set() or self._error:
            return
        changed = {k: v for k, v in values.items() if self.last.get((machine_id, k)) != v}
        if not changed:
            return
        for k, v in changed.items():
            self.last[(machine_id, k)] = v
        asyncio.run_coroutine_threadsafe(self._write(machine_id, changed), self.loop)

    async def _write(self, machine_id, values):
        for field, value in values.items():
            node = self.nodes[(machine_id, field)]
            vtype = self.machines[machine_id][field][1]
            await node.write_value(ua.DataValue(ua.Variant(value, vtype)))

    async def _serve(self):
        logging.getLogger('asyncua').setLevel(logging.WARNING)
        server = Server()
        await server.init()
        server.set_endpoint(f'opc.tcp://{self.host}:{self.port}/imo')
        server.set_server_name('IMO Supplier B machines')
        server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        idx = await server.register_namespace(NAMESPACE_URI)
        root = await server.nodes.objects.add_object(idx, 'Machine')
        for mid, fields in self.machines.items():
            folder = await root.add_object(ua.NodeId(f'Machine.{mid}', idx), mid)
            for field, (initial, vtype) in fields.items():
                var = await folder.add_variable(
                    ua.NodeId(f'Machine.{mid}.{field}', idx), field, ua.Variant(initial, vtype), vtype)
                self.nodes[(mid, field)] = var
        async with server:
            self._ready.set()
            await asyncio.Event().wait()

    def _run(self):
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._serve())
        except Exception as e:  # port in use, etc.
            self._error = e
            self._ready.set()
        except BaseException:
            pass
