# 3. Build-order change (demo step 4)

## Why this needs review
The script's step 4 says Vantiq detects a last-minute build-order change, re-sequences, and re-prioritizes the supplier's pick queue. Today it is a mock: the simulator sends the revision, and Vantiq does nothing with it. The user asked to plan this before building so it can be reviewed.

## What exists now
- Simulator `POST /scenario/reorder` (`_scenario_reorder` in `Simulation/simulator.py`): swaps the vehicles at positions 6 and 8 of the window, bumps the revision (117 to 118), updates the Supplier A seat sets, rewrites the plant MES `build_orders`, and publishes the build order on MQTT `/vantiqse/imo/plantmes/buildorder` with a `changes` list (`pushed back`, `pulled forward`).
- Vantiq `PlantMES` service handler `PlantMES.PlantMESData` normalizes it through `PlantMES.normalize`. Nothing acts on it.
- `Board.getSequenceBoard` already reads the new order from the plant MES database, so the rows swap on the board. The dashboard row note for the change is mock text.
- Supplier A's database has `seat_sets` and `seat_inventory`; there is no pick-queue table.

## Proposal to review
1. **Detect.** A handler on the build-order event compares this revision with the previous one (kept in the `BuildOrder` service's own state; the plant MES keeps only the current revision) and finds which vehicles moved and where.
2. **No collaboration.** A revision change is one request to one counterparty (Supplier A) and one confirmation, so it does not need a collaboration (those earn their place with several participants over time). A plain `BuildOrder` service handles it and reports each step through the shared UI update, keyed by revision number.
3. **Re-prioritize.** Vantiq writes the new pick order into Supplier A's system. This needs a small new table (for example `pick_queue(seq, vin, priority, updated_at)`), following the pattern that Vantiq writes requests into the supplier's own tables.
4. **Supplier acts.** The simulator plays Supplier A: it reads the pick queue and re-orders its picking, then confirms.
5. **UI updates and log.** Steps for the log: change received from the plant, vehicles identified, pick queue re-prioritized, Supplier A confirmed. The dashboard flashes the two rows amber with "Pulled forward" and "Pushed back".
6. **Buffer.** The pulled-forward vehicle's buffer shrinks and the pushed-back one's grows (depends on item 2).

## Decisions needed from you
Answer each one by filling in the line under it (a one-word answer or "go with your recommendation" is fine). A fresh session should not build until these are answered.

1. **Does Vantiq write to Supplier A?** Options: (a) Vantiq writes a pick-queue table in Supplier A's database and the simulator acts on it, (b) the supplier sees the new build order itself and Vantiq only reports it. Recommendation: (a), because it shows orchestration and matches the reservation pattern.
   Your answer: (a) Vantiq writes `pick_queue`; go with recommendation.
2. **How real is "re-sequence"?** Options: (a) the supplier's picks visibly reorder (the swapped vehicles are picked in the new order), (b) the dashboard only shows the rows swapped. Recommendation: (a).
   Your answer: (a) picks visibly reorder.
3. **Where the previous revision is kept for the diff.** Options: (a) in the `BuildOrder` service's own state, (b) re-read from the plant MES (not possible: it keeps only the current revision). Recommendation: (a).
   Your answer: (a) service state. As built: the plant's message already lists which vehicles moved, so no previous revision is stored yet.
4. **The "under two seconds" claim.** Measure it from real timestamps, or soften the wording in the script? Recommendation: measure it, soften it if it does not hold.
   Your answer: Measure it from real timestamps; soften if it does not hold.
5. **Fixed or varied swap.** Keep swapping positions 6 and 8, or vary it? Recommendation: keep it fixed so the script is repeatable.
   Your answer: Fixed (positions 6 and 8).

## Decision on structure
No new collaboration: a `BuildOrder` service (plain, not a collaboration) subscribes to the plant build-order event, writes Supplier A's `pick_queue`, and emits UI updates through `UIUpdates`. Routes: `PlantMES.OutboundBuildOrder` -> `BuildOrder.InboundBuildOrder`, `Seating.OutboundSeatingProgress` carries Supplier A's confirmation, `BuildOrder.OutboundUIUpdate` -> `UIUpdates.InboundUIUpdate`. New routes depend on item 7 (create them in the Modeler).

## Build status (2026-10-15)
Built and deployed, not yet run end to end: `BuildOrder` service + two handlers + `reprioritize` / `confirmed` procedures; `pick_queue` table and simulator worker; `PlantMES.OutboundBuildOrderChange` and `Seating.OutboundPickQueueConfirmed`; web log and row notes. Waiting on: the three routes drawn in the Modeler (item 7), a simulator restart, and the buffer (item 2).

## Constraints
Design-model pattern for service-to-service events. Visual handlers. Do not start or stop the simulator: say when it needs a restart.

## Done when
Clicking Build-order change makes Vantiq detect the diff, write the pick queue, receive the supplier's confirmation, and show each step in the log, with the two rows flashing and the buffer updating.
