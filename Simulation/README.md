# IMO simulator

Publishes the plant, seating-supplier, and tugger feeds to MQTT, and lets you trigger demo scenarios over HTTP. Starts and resets to a healthy steady state.

## Run

```
cd Simulation
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # first time only
.venv/bin/python simulator.py
```

Then open http://127.0.0.1:8765/ for the control page.

Options: `--speed 10` (sim seconds per real second), `--dry-run` (print instead of publish), `--broker`, `--mqtt-port`, `--http-port`.

## Control API

| Call | Effect |
|---|---|
| `POST /scenario/reorder` | Build-order rev 117 → 118, two positions swapped |
| `POST /scenario/damage` | Vision check fails on the seat set at position 4 (torn bolster) |
| `POST /scenario/tugger` | Tugger T3 faults (E-41) carrying the two soonest seat sets |
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
| `/vantiqse/imo/suppliera/partstatus` | on each stage change | none yet |
| `/vantiqse/imo/suppliera/quality` | on vision-check result | none yet |

Supplier A is REST in the demo story. Here it is published over MQTT because that is the broker the project already uses; add a source for its topics, or swap in a REST source later.

The simulator only reports events. Re-sequencing, replacement picks, and tugger reassignment are Vantiq's job, so after a scenario the simulated state stays disrupted until `/reset`.
