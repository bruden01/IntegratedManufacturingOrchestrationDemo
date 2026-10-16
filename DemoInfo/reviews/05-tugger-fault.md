# 5. Tugger fault (demo step 6)

## Why this needs review
The script has a tugger fault ending with Vantiq rerouting the load and the risk tile flipping from Low to Watch. It is a mock today. The user wants it as a real part of the demo so the script can be followed. This is also the main case for the "control tower that acts on delays" story (use case 2 in `demonotes.md`).

## What exists now
- Simulator `POST /scenario/tugger` (`_scenario_tugger`): T3 faults (`E-41`, "drive fault") while carrying the two soonest on-tugger seat sets; it updates Supplier B's `tuggers` row to `FAULT`, publishes `/vantiqse/imo/supplierb/tugger/T3/fault` and a telemetry message.
- Vantiq `Tugger` service handlers (`Tugger.Telemetry`, `Tugger.Fault`) normalize through `Tugger.normalizeTelemetry` and `Tugger.normalizeFault`. Nothing acts on them.
- `Board.getSequenceBoard` already shows a vehicle's tugger and its fault code, so the rows show the fault.
- The script wording: "Tugger stage turns amber (T3 down), two rows show Moved from T3 to T1, and the buffer drops to 6:10. The risk tile flips from Low to Watch."
- Also available but unused: charger and conveyor scenarios (`/scenario/charger`, `/scenario/conveyor`), OPC UA only, with no dashboard buttons.

## Proposal to review
1. **Detect.** A handler on the fault event identifies the tugger and the vehicles it was carrying.
2. **Case.** A collaboration opens for the fault, using the shared record shape from item 1.
3. **Find a replacement tugger.** Read Supplier B's fleet and the charger state over OPC UA; choose a healthy tugger with capacity and a charged charger.
4. **Reassign.** Write the new assignments into Supplier B's `assignments` table.
5. **Supplier B acts.** The simulator moves the loads to the new tugger.
6. **Buffer and risk.** The reassignment adds delay; the buffer (item 2) drops and the risk tile flips to Watch.
7. **Log.** Steps: fault received from the tugger, loads found, replacement tugger chosen (and why), loads moved, buffer recomputed.
8. **Ending.** The script ends it handled automatically with no person. Open question 2 in `demoflow.md` asks whether to escalate instead.

## Decisions needed from you
Answer each one by filling in the line under it (a one-word answer or "go with your recommendation" is fine). A fresh session should not build until these are answered.

1. **The ending.** Options: (a) handled automatically, as the script says now, (b) escalate to a supervisor for approval (open question 2 in `demoflow.md`). Recommendation: (a), keeping the human for the no-spare case.
   Your answer:
2. **How a reassignment is modelled in the buffer.** How much delay does moving loads add? Recommendation: the session proposes a number, and you review it with item 2.
   Your answer:
3. **Charger and conveyor faults.** Options: (a) only used as inputs to the tugger decision, (b) also get dashboard buttons as extra scenarios. Recommendation: (a); the demo has three scenarios.
   Your answer:
4. **What the dashboard shows for a faulted tugger** besides the row note and the Tugger stage alert. Recommendation: the Behind the scenes style panel used for the damaged seat, with the same actor chips.
   Your answer:
5. **Clearing the fault between runs.** Is `Demo.reset` plus the simulator `/reset` enough? Recommendation: yes.
   Your answer:

## Done when
Clicking Tugger fault makes Vantiq detect it, reassign the loads and show each step in the log; the two rows say "Moved from T3 to T1", the buffer drops and the tile reads Watch.

## Build status (2026-10-15)
Decisions: all taken as recommended. (1) handled automatically; (2) the fault takes the tightest buffer to 8:50 (Watch), then moved sets carry `reassignSec` 150 in `Board.bufferModel`, so it recovers to about 11:50 (Low); the script's "6:10" wording needs updating in item 6; (3) charger and conveyor only as inputs; (4) a "Tugger T3" block in the Behind the scenes panel, built into `App.jsx` (item 1 still open); (5) reset is enough. Also: no collaboration for the fault (plain `Fleet` service, like `BuildOrder`); capacity applies only to sets already on a tugger, because capacity is 4 per trip and each tugger has 4 sets assigned in the window.

Built:
- **Vantiq.** New `Fleet` service with handler `Fleet.InboundTuggerEvent` -> `Fleet.handle` -> `OutboundUIUpdate`. `Fleet.reassign` reads Supplier B's tuggers and assignments, Supplier A's seat-set stages, the plant MES, and each other tugger's charger over OPC UA; moves every set assigned to the faulted tugger (already-loaded first) to the healthiest tugger (highest charge, then fewest sets) by writing `tugger_requests` rows (`reason = 'TUGGER_FAULT'`, `from_tugger`). `Fleet.moved` turns Supplier B's confirmation into an update with the recomputed tightest buffer and risk. `Tugger` gains outbound event `OutboundTuggerEvent`, published by `Tugger.Fault` after normalizing. `Tugger.normalizeFault` also maps a `TuggerReassigned` message.
- **Buffer.** `Board.getSequenceBoard` reads confirmed fault moves and adds `reassignSec` to those rows; each row has `movedFrom`.
- **Simulator.** `_tugger_move_worker` waits for the requests, moves the loads after `TUGGER_MOVE_DELAY_SEC` (4 s), writes `assignments`, and reports `TuggerReassigned` on the tugger fault topic. `tugger_requests` gained `reason` and `from_tugger` (added to an existing database at startup). New vehicles entering the window skip a faulted tugger.
- **Web.** The mock log line for the Tugger button is gone; the panel block, log lines and the "Moved from T3 to T1" row note come from Vantiq.

Routes to draw in the Modeler (cannot be written through the API): add the `Fleet` service to the design model, then (1) `Tugger.OutboundTuggerEvent` -> `Fleet.InboundTuggerEvent`, (2) `Fleet.OutboundUIUpdate` -> `UIUpdates.InboundUIUpdate`.

## Later: make the request to Supplier B visible (2026-10-15)
Behaviour is right and stays as is. The requests to Supplier B (`Fleet.reassign`, `Fleet.replan`, and in the damaged seat flow `Issue.enrichDamagedSeating`, `Issue.assignTugger`) are `PUBLISH ... TO SOURCE` calls inside procedures, so the design model and visual event handlers do not show them. To change later: a `Fleet` outbound event `OutboundTuggerRequest` routed to a `Tugger` inbound `InboundTuggerRequest` whose handler does the write; Supplier B's confirmation already returns through `Tugger.OutboundTuggerEvent` -> `Fleet.InboundTuggerEvent`. Needs one more route drawn in the Modeler.
