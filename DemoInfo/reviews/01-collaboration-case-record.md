# 1. The collaboration as the case record

## Why this needs review
The user wants the Issue collaboration to be what drives the case, and wants it built correctly. Today it is not. The collaboration only holds the two events that opened it (the failed quality scan and the hold). The step list shown in the dashboard's "Behind the scenes" panel (who did what, when) is built inside the web page from the UI updates. So the web page, not the collaboration, is the record of the case.

## What exists now
- `Issue` is a collaboration service. Entity role `vehicle`, type `com.vantiqse.imo.s_Vehicle` (just `vin`). State is written behind every 5 minutes.
- Handler `Issue.InboundDamagedSeating`: `EventStream` -> `EstablishCollaboration` (entity id `event.FilterQualityFailed.vin`, behavior "Do not open multiple collaborations for one entity") -> `Enrich` (calls `Issue.enrichDamagedSeating`) -> `OutboundUIUpdate`.
- Because of that behavior, a repeat event for a VIN that already has an open collaboration is stopped at `EstablishCollaboration` and does not continue (confirmed by the user and by a test).
- Handler `Issue.InboundSeatingProgress`: `EventStream` -> `Progress` (calls `Issue.progressUpdate`) -> `OutboundUIUpdate`. `progressUpdate` calls `Issue.completeForVehicle(vin)` (partitioned by VIN) on `HoldReleased`, which finds the collaboration and sets it completed.
- Web: `Web/src/App.jsx` builds `incidents` from the UI updates (`incidentSteps`, `incidentNote`, `holdStatus`) and writes event-log lines in the subscription callback.
- UI update kinds today: `ReplacementReserved`, `NoReplacementAvailable`, `ReplacementPicked`, `HoldReleased`. Payload: kind, ts, vin, seq, station, vehicle, defect, seatSpec, bin, summary, failedTs, heldTs.

## What the user wants
- Messages in the Event and action log that say what is happening in the back end and who is doing it (Supplier A, Supplier B, the plant, Vantiq).
- The collaboration to be the thing that records and drives this, not the web page.
- To discuss how to build it correctly before it is built.

## Proposal to review
1. Each step of a case is recorded in the collaboration (actor, what, when, and the key data like the bin), as events for that vehicle arrive.
2. The UI update and the log message are produced from the collaboration's record, so the log reads the same as the case history.
3. The web page stops keeping its own copy of the steps and only displays what arrives.
4. The tugger fault case (item 5) may reuse the same shape. The build-order change (item 3) does not use a collaboration (single counterparty, no case to track); it shares only the UI update payload and the "Actor: what happened" wording, so the log has one voice.

## Decisions needed from you
Answer each one by filling in the line under it (a one-word answer or "go with your recommendation" is fine). A fresh session should not build until these are answered.

1. **Where the case history lives.** Options: (a) on the `vehicle` entity value, (b) in the collaboration's own results, (c) the session checks what the platform recommends for an appended history and proposes. Recommendation: (c), then pick what it says; (a) if there is no strong guidance.
   Your answer:
2. **Who is a collaborator.** Options: (a) only Vantiq's own logic, (b) also model the supplier systems, (c) also a supervisor, needed for the no-spare decision. Recommendation: (a) for now, and (c) added when the no-spare screen is built.
   Your answer:
3. **How later events reach the open case.** `EstablishCollaboration` with "do not open multiple" blocks downstream once a case exists, so picked and released events need another way in. Options: (a) keep the lookup by VIN used today (`completeForVehicle`), (b) a different handler pattern you prefer, which you would explain. Recommendation: (a), unless you know a cleaner visual pattern.
   Your answer:
4. **When a case closes, and what a repeat does.** Today it closes when the hold is released and a later damage for the same VIN opens a new case. Is that right? Recommendation: yes, keep it.
   Your answer:
5. **Log wording.** Approve the form "Actor: what happened" (for example "Supplier A: placed a hold on seat set 2044"), or give the style you want.
   Your answer:

## Constraints
- Only use the in-memory collaboration (`Issue.ActiveCollabsGetCached` and the generated procedures). Never read `system.collaborations`.
- Keep the design-model pattern: the UI update goes `Issue.OutboundUIUpdate` -> `UIUpdates.InboundUIUpdate` -> `UIUpdatePayload`.

## Done when
A damaged-seat run shows a log entry for every step with the right actor, built from the collaboration's record, and the collaboration state shows the same history. `Demo.reset` still clears everything.
