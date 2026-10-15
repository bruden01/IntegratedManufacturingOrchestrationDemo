# 7. Design model routes read back empty

## Why this needs review
This is housekeeping from the last build, but it needs a careful look before more routes are added, because the routes are how services are connected.

## What happened
- The design model `com.vantiqse.imo.Design` holds a diagram (`contents`) and a list of saved routes (`serviceEventRoutes`). Routes: `Seating.OutboundDamagedSeating` -> `Issue.InboundDamagedSeating`, `Issue.OutboundUIUpdate` -> `UIUpdates.InboundUIUpdate`, and `Seating.OutboundSeatingProgress` -> `Issue.InboundSeatingProgress`.
- Routes are normally created by drawing links in the Modeler. The first two read back correctly after the diagram was saved through the API (they showed in `serviceEventRoutes`).
- After adding the third link through the API, it did not appear. An explicit update of `serviceEventRoutes` through the API then wiped all routes, and re-saving the diagram did not bring them back: `serviceEventRoutes` now reads `[]` over the API.
- At runtime the routing still worked: a damaged seat still opened a collaboration, and the progress events (`REPLACEMENT_PICKED`, `HOLD_RELEASED`) reached `Issue` and completed the collaboration. So the platform appears to route correctly while the readback says empty.
- The local `designmodels/com/vantiqse/imo/Design.json` has the intended diagram and the three routes; the server's saved `serviceEventRoutes` does not match it.

## What to check
- Open the design model in the Modeler. Do the three links show? Save it once and re-read `serviceEventRoutes`.
- Does a damaged-seat run still route (Quality fail then hold gives an open collaboration; picked then released completes it) after the Modeler save?
- Is the empty readback just how the API reports it, or are the routes truly gone and routing is happening some other way?
- Is the diagram saved by the Modeler identical to `Design.json` in the repo? If not, refresh the repo file.

## Do not
Do not rewrite the diagram through the API again to fix this. Edit it in the Modeler.

## Decisions needed from you
Answer each one by filling in the line under it (a one-word answer or "go with your recommendation" is fine). A fresh session should not build until these are answered.

1. **Who fixes it.** Options: (a) you open the design model in the Modeler and save it, then tell the session what you see, (b) the session reads the server state and proposes a fix without changing the diagram through the API. Recommendation: (a) first; do not rewrite the diagram through the API again.
   Your answer: (a). The design model was edited in the Modeler.
2. **If the Modeler shows the three links but the readback is still empty,** do you want the session to treat the readback as unreliable and rely on the runtime tests, or investigate further? Recommendation: rely on the runtime tests and keep the repo's `Design.json` matched to the Modeler's saved version.
   Your answer: Moot: after the Modeler save the routes read back correctly.

## Status (2026-10-15)
Resolved. After the Modeler save, `serviceEventRoutes` reads back all six routes (the three damaged-seat and UI routes plus `PlantMES.OutboundBuildOrderChange` -> `BuildOrder`, `Seating.OutboundPickQueueConfirmed` -> `BuildOrder`, `BuildOrder.OutboundUIUpdate` -> `UIUpdates`). The repo's `Design.json` was synced from the server. Runtime routing was confirmed by a build-order run end to end.

## Done when
The Modeler shows the three links, the saved routes read back correctly, and the repo's `Design.json` matches.
