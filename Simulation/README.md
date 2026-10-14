# IMO simulator

Publishes the plant and tugger feeds to MQTT, posts the seating-supplier feed to Vantiq over REST, serves Supplier B machine data over OPC UA, and lets you trigger demo scenarios over HTTP. Starts and resets to a healthy steady state.

## Run

```
cd Simulation
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # first time only
.venv/bin/python simulator.py
```

Then open http://127.0.0.1:8765/ for the control page. The simulator also starts an OPC UA server (below); disable it with `--opcua-port 0`.

Options: `--speed 10` (sim seconds per real second), `--dry-run` (print instead of publish), `--broker`, `--mqtt-port`, `--http-port`.

## Control API

| Call | Effect |
|---|---|
| `POST /scenario/reorder` | Build-order rev 117 → 118, two positions swapped |
| `POST /scenario/damage` | Vision check fails on the seat set at position 4 (torn bolster) |
| `POST /scenario/tugger` | Tugger T3 faults (E-41) carrying the two soonest seat sets |
| `POST /scenario/charger` | Charging station CHG-2 faults (E-17); OPC UA feed only |
| `POST /scenario/conveyor` | Dock conveyor CONV-1 jams (J-03); OPC UA feed only |
| `POST /reset` | Back to rev 117, all healthy |
| `POST /speed?factor=10` | Change speed (0.1 to 60) |
| `POST /pause`, `POST /resume` | Freeze or resume time |
| `GET /status` | Current state |

## Topics (broker `public.vantiq.com:1883`)

| Topic | Rate | Vantiq source |
|---|---|---|
| `/vantiqse/imo/plantmes/buildorder` | one per vehicle (every 180 sim-seconds) plus revisions | `com.vantiqse.imo.PlantMES` |
| `/vantiqse/imo/supplierb/tugger/<T1\|T2\|T3>/telemetry` | every 2 sim-seconds per tugger | `com.vantiqse.imo.SupplierBTugger` |
| `/vantiqse/imo/supplierb/tugger/<id>/fault` | on fault | `com.vantiqse.imo.SupplierBTugger` |

## Seating (REST, direct to Vantiq)

Supplier A is REST, so the simulator POSTs straight to the inbound events of the Vantiq service `com.vantiqse.imo.Seating`, with no broker or source in between:

| Event | Posted | Handler app |
|---|---|---|
| `PartStatus` | on each stage change | `com.vantiqse.imo.Seating.PartStatus` |
| `Quality` | on vision-check result | `com.vantiqse.imo.Seating.Quality` |

`POST https://dev.vantiq.com/api/v1/resources/services/com.vantiqse.imo.Seating/<event>` with a bearer token. The token comes from `VANTIQ_TOKEN`, or else from `authToken` in `../OpcUaConnector/serverConfig/server.config`. Without a token the simulator still runs but logs that Seating events are not sent. Failed posts are counted in `/status` (`seatingPostErrors`). `--dry-run` prints the POSTs instead.

The simulator only reports events. Re-sequencing, replacement picks, and tugger reassignment are Vantiq's job, so after a scenario the simulated state stays disrupted until `/reset`.

## OPC UA feed

Supplier B's machine data is served as OPC UA at `opc.tcp://localhost:4840/imo` (no security, anonymous), namespace URI `urn:vantiqse:imo`. This is separate from the tugger fleet, which is MQTT. Nodes are string ids `Machine.<id>.<field>`:

| Machine | Fields |
|---|---|
| `CHG-1`, `CHG-2`, `CHG-3` (tugger charging stations) | `State` (IDLE, CHARGING, FAULT), `ChargePct`, `FaultCode` |
| `CONV-1` (dock conveyor) | `State` (RUNNING, STOPPED, JAMMED), `CartCount`, `FaultCode` |

The charger and conveyor scenarios set `State` to `FAULT` / `JAMMED` and `FaultCode` to `E-17` / `J-03`. Reset clears them.

The simulator only hosts the OPC UA server. The bridge to Vantiq is the OPC UA connector in `../OpcUaConnector` (see its README), which connects to this server and relays node changes to the Vantiq source `com.vantiqse.imo.SupplierBMachines`.

Each node change arrives as a source message with `nodeIdentifier`, `nsu`, `nodeId`, `dataValue`.
