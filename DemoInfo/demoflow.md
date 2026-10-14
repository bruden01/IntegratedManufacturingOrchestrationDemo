# Demo flow, step by step

Total about 6–8 minutes. Each step has what the audience sees, what the presenter says, and what is happening behind the screen.

## 0. Setup (before anyone arrives)
Drawer closed, dashboard live, all KPIs green. The simulator is already running at normal pace, so the board is moving without the presenter touching anything.

## 1. Frame the problem (about 30 seconds)
**Say:** "Seats are built to order and delivered in exact vehicle sequence. If the wrong seat reaches the line, or one is late, the line stops. Every minute has a price."
**Explain JIS if the audience may not know it:** "This is Just-in-Sequence. Not just the right part at the right time, but the right part in the exact order the vehicles are built, so the line never sorts or waits. Seats, bumpers, and cockpits work this way because they vary by vehicle and are too bulky to stock. That also means there is almost no buffer. One wrong, damaged, or late seat set can stop the line." (Full definition in `glossary.md`.)
**Show:** The KPI strip, especially "Cost of one line-stop minute." It defaults to $25,000 and can be changed live on the Settings page in the left menu.

## 2. Show the connected plant (about 1 minute)
**Show:** The header status ("3 sources connected") and the sources strip at the bottom: the plant MES, a seating supplier over REST, and a tugger fleet over MQTT/OPC-UA.
**Say:** "Three companies' systems, three protocols. Vantiq normalizes them into one event model, and nobody replaced anything." This is use case #5, and it sets up everything after.
**Behind the scenes:** The simulator publishes three feeds. Vantiq sources ingest them and map each into the same event shape (the "Normalized event" box).

## 3. Show normal operation (about 1 minute)
**Show:** The sequence board in build order, each vehicle's seat set moving through Picking, Sequenced, Staged, On tugger, and the Park flow counts. The "Need in" countdowns tick down.
**Say:** "This is a healthy shift. Every seat set has a deadline at the line."
**Behind the scenes:** Events arrive continuously. Vantiq updates each part's status and recomputes the buffer to its need time.

## 4. Disruption 1: build-order change (about 1.5 minutes)
**Do:** Pull up the drawer and click **Build-order change**. Close the drawer so the audience sees the dashboard, not the controls.
**See:** Revision 117 becomes 118. Two rows flash amber and swap ("Pulled forward" and "Pushed back"). A log entry appears with the action Vantiq took.
**Say:** "The plant changed its mind. Vantiq re-sequenced the picks in under two seconds, with no one phoning the supplier."
**Behind the scenes:** The simulator publishes a revised build order. Vantiq detects the diff, recomputes the sequence, and re-prioritizes the supplier's pick queue.

## 5. Disruption 2: damaged seat (about 1.5 minutes)
**Do:** Open the drawer, click **Damaged seat at station**.
**See:** Seq 2044 turns amber ("Re-picked, replacement from buffer B-14"). The Sequence stage in Park flow flags the swap. The tightest-buffer KPI drops from 14:20 to 11:40.
**Say:** "A vision check caught a bad bolster. Vantiq found a replacement in inventory, re-slotted it, and held the line-side time."
**Behind the scenes:** A quality event comes in from the supplier feed. Vantiq checks buffer inventory, reserves a replacement, and updates the plan.

## 6. Disruption 3: tugger fault (about 1.5 minutes)
**Do:** Open the drawer, click **Tugger fault**.
**See:** Tugger stage turns amber ("T3 down"), two rows show "Moved from T3 to T1," and the buffer drops to 6:10. The risk tile flips from **Low** to **Watch**.
**Say:** "Now it's getting tight. Vantiq rerouted the load, but it also tells us we've lost margin."
**Behind the scenes:** Fault telemetry arrives over MQTT. Vantiq reassigns the affected loads and recomputes each deadline.

## 7. Close with the log and the point (about 1 minute)
**Show:** The event and action log, which reads as a short story: event, then what was done.
**Say:** "Three disruptions, all handled, none waiting on a person, and the line never stopped. This works across companies because Vantiq sits between the systems instead of replacing them."
**Tie to the others:** If it fits, mention that the same pattern applies to battery genealogy (#3) and supplier disruption response.

## 8. Reset
**Do:** Open the drawer and click **Reset** to run it again for the next group.

---

## What is real today versus not
- **Done:** The UI and the button-driven mock of steps 4–6.
- **Still to build:**
  - A simulator that publishes steady-state events (steps 2–3), so the board moves on its own.
  - Vantiq doing the actual re-sequencing and decisions.
  - The UI reading its state from Vantiq.

## Open questions
1. **Pace.** Should the board move in real time, or run sped up (say, 10× faster) so the countdowns create visible urgency?
2. **Step 6 ending.** Should the tugger fault end with the system handling it, or escalate to a person ("needs supervisor approval") to show human-in-the-loop? The second is more realistic but adds a screen.
3. **Part family.** Is seats the right example for the audience? Cockpit modules would work too, and they are more visibly sequence-critical.
