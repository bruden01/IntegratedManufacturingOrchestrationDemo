# 2. The buffer to line-side need

## Why this needs review
The "Tightest buffer to line-side need" KPI, the Low/Watch risk tile and the "Need in" countdown are not real. Items 3, 4 and 5 all want to show the buffer changing (the script has it dropping when a seat is damaged or a tugger faults, and the risk tile going from Low to Watch). Nothing can show that until the buffer is defined and computed from real data.

## What exists now
- `Web/src/data.js` has `BASE_SLACK_SECONDS`, `DAMAGE_SLACK_COST`, `TUGGER_SLACK_COST` and `WATCH_THRESHOLD_SECONDS` (600 s). `App.jsx` computes `slackSec = BASE - damage cost - tugger cost` from button flags. Mock.
- `Board.getSequenceBoard` returns per-vehicle `needInSec` read from the plant MES `build_orders.need_in_sec`. That value is "sim seconds until needed, as of `updated_at`". The simulator only rewrites it when the build order changes (a vehicle advances or a revision), so between those the number is static and the dashboard's countdown does not tick.
- The simulator's stages come from `stage_for(need)` in `Simulation/simulator.py`: stage thresholds on the remaining need time. Each vehicle has a stage (Queued, Picking, Sequenced, Staged, On tugger).
- Speed: the simulator runs at a speed factor (`/speed`, `/status`); sim time = real time x speed.

## Proposal to review
- **Definition.** Buffer for a vehicle = time until it is needed at line side, minus the estimated time still needed to get its seat set there. Tightest buffer = the minimum over the vehicles in the window.
- **Estimate.** Remaining time to line side from the seat set's stage (a fixed lead time per stage), plus any delay added by events: a hold, a replacement pick still to come, a tugger reassignment.
- **Where.** A Vantiq procedure (for example `Board.getBuffer` or inside `getSequenceBoard`) returns the buffer per vehicle and the tightest one. The dashboard shows it.
- **Countdown.** Return each order's `updated_at` and the server time with the board, and have the page count down from there using the simulator speed, so "Need in" ticks and drops between refreshes.
- **Risk tile.** Watch when the tightest buffer is under the threshold (600 s today, in `data.js`).

## Decisions needed from you
Answer each one by filling in the line under it (a one-word answer or "go with your recommendation" is fine). A fresh session should not build until these are answered.

1. **Definition of buffer.** Time until needed at line side, minus the estimated time still to get the seat set there; the KPI is the minimum over the window. Right? Recommendation: yes.
   Your answer: Changed. The simulator delivers every seat set exactly at its need time, so need minus lead time sits near zero. Built instead: buffer = planned slack (860 s) minus the delay from active exceptions; the KPI is the minimum over the window.
2. **Where the lead times per stage come from.** Options: (a) derive them from the simulator's stage thresholds, (b) a small table kept in Vantiq. Recommendation: (b), so Vantiq does not depend on simulator internals.
   Your answer: (b) A procedure in Vantiq, `Board.bufferModel`, holds the numbers: planned slack 860 s, watch threshold 600 s, hold 100 s, replacement still to be picked 60 s, tugger fault 330 s.
3. **Who runs the countdown.** Options: (a) the page counts down from timestamps the board returns, (b) Vantiq recomputes every poll. Recommendation: (a), with Vantiq returning the base values.
   Your answer: (a) The page counts down "Need in" from the board's `asOf` and `serverNow` and the simulator speed read from `/status`. The buffer itself is steady when healthy, so it has no countdown.
4. **How much each event delays the buffer.** Hold, a replacement still to come, a tugger reassignment: pick the amounts, or let the session propose numbers that give believable results. Recommendation: the session proposes, you review.
   Your answer: Proposed: hold 100 s plus 60 s while a reserved spare is still to be picked (160 s, the script's 14:20 to 11:40), and 330 s for a faulted tugger. Delays are per vehicle and the tile shows the worst vehicle, they are not summed across vehicles.
5. **The script's example numbers** (14:20 to 11:40, then 6:10). Reproduce them, or let the real numbers show and change the script to match? Recommendation: let real numbers show and update the script.
   Your answer: Real numbers show. The script's 14:20 to 11:40 reproduces for a damaged seat; a tugger fault alone gives 8:50 (Watch), not 6:10, because the script adds both delays to one vehicle. Update the script to match.
6. **"Event to action" KPI.** Fix it in this same change using real timestamps, or leave it mock for now? Recommendation: fix it here.
   Your answer: Done (2026-10-15): the tile shows seconds from the plant message (or the later of failed scan and hold) to Vantiq's action, from the UI update timestamps. The buffer itself (items 1 to 5) is still mock.

## Status (2026-10-15)
Built. `Board.getSequenceBoard` returns a `bufferSec` per vehicle, `tightestBufferSec`, `watchSec`, `asOf` and `serverNow`; `Board.bufferModel` holds the numbers. A damaged seat takes the tightest buffer from 14:20 to 11:40 and back when the hold is released. A tugger fault gives 8:50 (Watch) and stays until doc 05 handles it. The hold dip lasts only as long as the hold (about 10 real seconds at 1x).

## Done when
The tightest buffer and the risk tile come from Vantiq data, the countdown ticks, and a damaged seat or a tugger fault visibly reduces the buffer.
