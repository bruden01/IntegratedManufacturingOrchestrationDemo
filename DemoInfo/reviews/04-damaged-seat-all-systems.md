# 4. Finishing the damaged seat across all systems (demo step 5)

## Why this needs review
The feedback asks that the damaged-seat scenario show orchestration across the plant MES, two supplier databases, OPC UA machine data and the tugger system. As of 2026-10-15 the flow uses the plant MES (to look up the seat spec) and Supplier A's database (reserve the spare). Supplier B's database and the tuggers only feed the board display, and OPC UA is not involved. The user said this scenario needs to be finished.

## What exists now
See the shared README for the full flow. The steps today, in the Behind the scenes panel: Supplier A vision check fails, Supplier A places the hold, Vantiq reserves a spare, the warehouse picker takes it, the hold is released and Vantiq closes the case.
- Supplier B: `Databases/schema/supplier_b.sql` has `tuggers(id, model, capacity, state, fault_code)` and `assignments(seq, tugger_id)`. The `SupplierBDB` source is a JDBC source (read and write path proven for Supplier A; untested for Supplier B).
- OPC UA: the `SupplierBMachines` source monitors `Machine.CHG-1..3.{State,ChargePct,FaultCode}` and `Machine.CONV-1.{State,CartCount,FaultCode}`; the `Machines` service normalizes them.

## Proposal to review
After the spare is picked (or at the point the replacement is ready to move), add steps where Vantiq:
1. **Checks the tuggers.** Reads tugger state from Supplier B's database and the charger state and charge level over OPC UA, to find a healthy tugger with a charged charger.
2. **Assigns.** Writes the replacement's assignment into Supplier B's `assignments` table (a request into the supplier's own table, as with the reservation).
3. **Supplier B acts.** The simulator's tugger honors the assignment and the seat set goes ON_TUGGER on that tugger.
4. **Reports.** New steps in the case record and the log (for example "Vantiq checked T1 and its charger CHG-1", "Vantiq assigned the replacement to T1").
5. **Buffer.** The hold and replacement delay the seat set; the buffer (item 2) reflects it and the script's "held the line-side time" claim becomes visible.

## What changed since this document was written (2026-10-15)
Read this before the proposal; it changes what a new session can reuse.
- **Build-order change is built** (item 3, see its Build status). It is the working model to copy: a plain `BuildOrder` service with two visual event handlers (`InboundBuildOrderChange`, `InboundPickQueueConfirmed`), procedures `BuildOrder.reprioritize` / `BuildOrder.confirmed`, a `pick_queue` table in Supplier A's database that Vantiq writes and the simulator acts on (`_pick_queue_worker` in `Simulation/simulator.py`, `requested_picks` / `confirm_pick` in `Simulation/erp.py`), a progress event posted back as a `PartStatus` stage and filtered in `SeatingData`, and a route to `UIUpdates`. Item 4 can follow the same shape with Supplier B's `assignments` table.
- **The dashboard subscription was fixed.** UI updates now reach the dashboard. A service's outbound event is subscribed to as `resourceName: 'events'`, `resourceId: '/services/<service>/<event>'`, `persistent: true` (see `Web/src/services/updates.js`). The bare `service/event` form is rejected with a 400. The damaged-seat panel and log now fill from Vantiq.
- **The design model routes read back correctly** (item 7 is resolved). Routes must still be drawn in the Modeler, never written through the API.
- **The buffer is computed from Vantiq** (item 2): `Board.bufferModel` holds planned slack (860 s), watch threshold (600 s), hold 100 s, replacement-to-be-picked 60 s, tugger fault 330 s. `Board.getSequenceBoard` returns `bufferSec` per vehicle. A damaged seat already takes the tightest buffer to 11:40. Adding the tugger step must not break this; if the replacement's tugger assignment should shorten or extend the delay, change the numbers in `Board.bufferModel`.
- **Case-record item 1 is still open**: the damaged-seat case's step list is still built in the web page from UI updates (`incidentSteps` in `Web/src/App.jsx`). New steps for this item must appear in the "Behind the scenes" panel and the event log; either extend `incidentSteps` and the `UIUpdates` handling in `App.jsx`, or settle item 1 first.

## Where the pieces are
- **Plant MES lookup, spare reservation:** `Vantiq/.../procedures/com/vantiqse/imo/Issue_enrichDamagedSeating.vail` (reads `PlantMESDB`, reserves in `SupplierADB`, returns the UI update payload).
- **Pick, hold release:** simulator `_picker` in `Simulation/simulator.py` (`REPLACEMENT_PICKED` then `HOLD_RELEASED`, posted to `Seating` as `PartStatus`), normalized by `Events.fromPartStatus`, filtered in `collaborationtypes/.../Seating/SeatingData.json` (`FilterProgress`), handled by `Issue.InboundSeatingProgress` -> `Issue.progressUpdate`.
- **Supplier B database:** `Databases/schema/supplier_b.sql` (`tuggers`, `assignments(seq, tugger_id)`); the simulator rewrites `assignments` from each vehicle's `tugger` in `erp.sync_build_orders`/`_insert_assignments`, so today the assignment follows the simulator's fixed `TUGGER_CYCLE`, and a read of `assignments` for the damaged vehicle returns whatever the cycle gave it.
- **OPC UA:** `SupplierBMachines` source, `Machines` service; chargers `CHG-1..3` (`State`, `ChargePct`, `FaultCode`), pushed by `_update_opcua` in the simulator. `ChargePct` is a simple decreasing value, `State` is `CHARGING` when the tugger is docked, else `IDLE`. Vantiq has no procedure that reads machine state on demand; `Machines` only normalizes the feed into `Events`. An on-demand read of a charger (item 1 in the proposal) needs either a procedure that queries the source or the latest normalized event.
- **The `SupplierBDB` JDBC source** reads (the board reads `tuggers` and `assignments` from it) but a write has never been run against it. Test one first (`PUBLISH {query: "..."} TO SOURCE SupplierBDB`, as the reservation does for Supplier A).

## Patterns and gotchas that cost time in the last session
- **Writing to a supplier:** `PUBLISH {query: "<SQL>"} TO SOURCE <Source>` runs any statement, including `INSERT ... ON CONFLICT DO UPDATE`. Escape single quotes in values (`.replace("'", "''")`).
- **New service event:** declare the event type on the service (`eventTypes`), then draw the route in the Modeler. Inbound visual handlers belong in the event type's `implementingResource`, not in `internalEventHandlers` (leave that `[]` or the service shows an error). A service with an explicit `interface` needs every procedure listed there.
- **Deploying to Vantiq:** update the local file and the server together (the MCP `insert`/`update` tools). The `update` response for a procedure on `Board` is huge; check `vailErrors` with a `select` using `props` instead. Collaboration types are updated by `name` with the full `assembly`.
- **Simulator:** the user restarts it. A new table needs a restart (it creates tables from `Databases/schema/*.sql` at startup). `POST http://127.0.0.1:8765/scenario/damage` triggers the damaged seat, `/reset` resets; use them to test.
- **Do not repeat:** do not rewrite the design model through the API; do not read `system.collaborations`; keep JSON file formatting as the repo has it (service and project files use Jackson style `"key" : value`).
- **Clocks:** the simulator and the Vantiq server clocks agree to about 100 ms, so timestamps can be compared.

## How to test
1. Reset, then press Damaged seat (or `POST /scenario/damage`).
2. The Behind the scenes panel and event log should show every step with its actor, including the new Supplier B and OPC UA steps and a named tugger.
3. `sqlite3 Databases/data/supplier_b.db "select * from assignments"` shows the replacement's assignment written by Vantiq.
4. The tightest buffer dips (11:40 today) and recovers on release.

## Decisions needed from you
Answer each one by filling in the line under it (a one-word answer or "go with your recommendation" is fine). A fresh session should not build until these are answered.

1. **Depth of the tugger and OPC UA part.** Options: (a) read tugger and charger state and report it only, (b) also assign the replacement to a tugger by writing Supplier B's `assignments` table. Recommendation: (b), since it shows all five systems acting.
   Your answer:
2. **How the simulator handles an assignment.** Today a vehicle's tugger comes from a fixed cycle. OK for the simulator to read `assignments` and use it? Recommendation: yes.
   Your answer:
3. **Order of the new steps** relative to the pick and the hold release. Recommendation: after the pick and before the release, so the release means the replacement is on its way.
   Your answer:
4. **The no-spare branch.** Options: (a) it keeps ending at "needs a person to decide" for now, (b) build the decision screen as part of this item. Recommendation: (a) now, (b) as its own item later.
   Your answer:
5. **Which vehicle is damaged.** Always the one at position 4, or vary? Recommendation: keep it fixed so the script is repeatable.
   Your answer:

## Done when
A damaged-seat run shows steps touching plant MES, Supplier A, Supplier B and OPC UA, each attributed to who did it, ending with the replacement on a named tugger and the case closed.

## Build status (2026-10-15)
Decisions: all five taken as recommended (assign the tugger; simulator honors it; steps after the pick and before the release; no-spare branch unchanged; vehicle fixed at position 4). Step list extended in `Web/src/App.jsx` (`incidentSteps`), item 1 still open.

Built, not yet run end to end:
- **Request table, not a direct `assignments` write.** `Databases/schema/supplier_b.sql` gains `tugger_requests(vin, seq, tugger_id, state)`. The simulator rewrites `assignments` on every resync, so a direct write would be clobbered. Vantiq writes a REQUESTED row (same shape as `pick_queue`); the simulator's `_picker` waits for it, calls `erp.confirm_tugger` (writes `assignments` and sets the vehicle's tugger), posts `PartStatus` stage `TUGGER_ASSIGNED`, then releases the hold. **Needs a simulator restart** (new table).
- **Vantiq.** New `Issue.assignTugger` reads tuggers and loads from `SupplierBDB`, reads each charger over OPC UA with `SELECT ONE FROM SOURCE SupplierBMachines WITH queryStyle = "NodeId", nodeIdentifier, nodeIdentifierType, nsu` (verified working; `queryStyle` is required), picks the healthy tugger with the highest charge then fewest seat sets, and writes the request. `Issue.progressUpdate` calls it on `ReplacementPicked` and handles the new `ReplacementOnTugger`. `Events.fromPartStatus` maps `TUGGER_ASSIGNED`; `SeatingData.FilterProgress` lets it through. No new route: it reuses `Seating -> Issue.InboundSeatingProgress`. Deployed to the server and saved to the files; no compile errors.
- **Not yet verified:** the write to `SupplierBDB` (the table does not exist until the restart), and the full run.
- **Charger values are flat.** All three chargers read the same charge, so the pick falls to load then tugger id (T1 today).
