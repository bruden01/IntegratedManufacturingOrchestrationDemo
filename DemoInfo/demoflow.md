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
**See:** Revision 117 becomes 118. Two rows swap ("Pulled forward" and "Pushed back"). The pulled-forward row shows **Queued → Picking (pending)** and the tightest buffer starts to fall. The **Behind the scenes** panel lists the plant's change and Vantiq's request to Supplier A.
**Do:** Take your time to point things out, then click **Supplier A: confirm new pick order** above the board. That plays a person at Supplier A committing that the new order can be picked.
**See:** The pulled-forward row moves to **Picking** and the buffer recovers. Vantiq then checks the two tuggers in Supplier B's fleet system and their chargers over OPC UA and asks Supplier B to swap the loads. About 6 seconds later Supplier B reports the swap, and Vantiq recomputes the buffer. Every step shows in the panel and the log.
**Say:** "The plant changed its mind. Vantiq asked Supplier A to re-sequence its picks. Until Supplier A commits, it is only a request, and the buffer gets worse the longer it waits. Once Supplier A confirms, Vantiq carries the change into Supplier B's fleet system so the tuggers follow the new order. No one phoned either supplier."
**Behind the scenes:** The simulator publishes a revised build order. Vantiq re-prioritizes Supplier A's pick queue. The simulator waits for the Confirm button, then Supplier A confirms. Vantiq (`Fleet.replan`) checks both tuggers and chargers and writes a swap request for each set into Supplier B's `tugger_requests`. After `TUGGER_REPLAN_DELAY_SEC` (6 s) the simulator plays Supplier B swapping the loads and reporting it on the tugger channel.

## 5. Disruption 2: damaged seat (about 2 minutes)
**Do:** Open the drawer, click **Damaged seat at station**, then close the drawer. Watch the **Behind the scenes** panel fill in over about 15 seconds.
**See:** The seat set at position 4 goes to **On hold: finding replacement**, then **replacement reserved**, then **replacement picked**, and then back to its normal stage. The Behind the scenes panel lists each step with who did it (Supplier A or Vantiq) and the time. The row carries a one-line callout saying what is happening now. The log gets an entry for each step.
**Say:** "A vision check caught a bad bolster. The supplier's own system put a hold on that seat set. That is a hold on one seat set, not on the line. Vantiq saw the hold, found a matching spare in the supplier's inventory and reserved it. The supplier's picker took it from the bin and released the hold. Vantiq closed the case. The line only stops if the replacement misses that vehicle's need-in time, and it didn't."
**Point at the panel:** The blue **Supplier A** steps are the supplier's systems acting on their own. The green **Vantiq** step is the orchestration: it joined the failed quality scan with the hold, looked up the vehicle's seat spec in the plant MES, reserved a spare in the supplier's inventory, then tracked the pick and closed the case.
**Behind the scenes:** The simulator posts a failed quality scan, then 3 seconds later plays Supplier A's system placing the hold. Vantiq joins the two events for the same VIN and opens one case for that vehicle (a repeat for the same VIN does not open another). It reserves a spare by writing to the supplier's inventory. The simulator plays the warehouse picker: 4 seconds after the reservation it takes the spare from the bin, and 3 seconds after that the supplier releases the hold. Each step reaches the dashboard through one Vantiq UI-update subscription.
**If there is no spare:** the panel shows "No spare in stock. Needs a person to decide". That is the point where a person would step in. The person's decision screen is not built yet.

## 6. Disruption 3: tugger fault (about 1.5 minutes)
**Do:** Open the drawer, click **Tugger fault**.
**See:** Tugger stage turns amber ("T3 down"), two rows show "Moved from T3 to T1," and the buffer dips to about 10:15 for a moment, then recovers to 11:50 once the loads are moved. The risk tile flips from **Low** to **Watch** during the dip (the Watch threshold is 11:00), then returns to **Low**.
**Say:** "For a moment it got tight. Vantiq rerouted the loads and the buffer recovered, but we still lost margin: about 150 seconds on every set that had to move."
**Timing:** The dip lasts only a few seconds, so point at the risk tile as soon as you click.
**Behind the scenes:** Fault telemetry arrives over MQTT. Vantiq reassigns the affected loads and recomputes each deadline.

## 7. Close with the log and the point (about 1 minute)
**Show:** The event and action log, which reads as a short story: event, then what was done.
**Say:** "Three disruptions, all handled, none waiting on a person, and the line never stopped. This works across companies because Vantiq sits between the systems instead of replacing them."
**Tie to the others:** If it fits, mention that the same pattern applies to battery genealogy (#3) and supplier disruption response.

## 8. Reset
**Do:** Open the drawer and click **Reset** to run it again for the next group.

---

## What is real today versus not
- **Done:** The UI and the button-driven mock of steps 4 and 6. Step 5 (damaged seat) runs for real through Vantiq, with a simulated supplier system and warehouse picker.
- **Still to build:**
  - A simulator that publishes steady-state events (steps 2–3), so the board moves on its own.
  - Vantiq doing the actual re-sequencing and decisions (steps 4 and 6, and protecting the line when a replacement would be late).
  - The person's decision screen for a damaged seat with no spare.
  - The UI reading its state from Vantiq.

## Open questions
1. **Pace.** Should the board move in real time, or run sped up (say, 10× faster) so the countdowns create visible urgency?
2. **Step 6 ending.** Should the tugger fault end with the system handling it, or escalate to a person ("needs supervisor approval") to show human-in-the-loop? The second is more realistic but adds a screen.
3. **Part family.** Is seats the right example for the audience? Cockpit modules would work too, and they are more visibly sequence-critical.
