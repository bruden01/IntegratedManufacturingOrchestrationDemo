# Demo review items

One document per item that needs a decision before we build. Each is written so a fresh Claude session can pick it up on its own: read this README first for the shared context, then the one item document.

## The items

| # | Document | What it decides | Needs first |
|---|---|---|---|
| 1 | [01-collaboration-case-record.md](01-collaboration-case-record.md) | How the Issue collaboration records who did what, and how the event and action log is driven from it | none |
| 2 | [02-buffer-kpi.md](02-buffer-kpi.md) | What "buffer to line-side need" means and how it is computed from real data | none |
| 3 | [03-build-order-change.md](03-build-order-change.md) | Real Vantiq handling of a last-minute build-order change (demo step 4) | 1, and 2 for the buffer |
| 4 | [04-damaged-seat-all-systems.md](04-damaged-seat-all-systems.md) | Finishing the damaged-seat scenario so it touches all five sources (demo step 5) | 1, 2 |
| 5 | [05-tugger-fault.md](05-tugger-fault.md) | Real Vantiq handling of a tugger fault (demo step 6) | 1, 2 |
| 6 | [06-narrative-and-talking-points.md](06-narrative-and-talking-points.md) | Script wording: art of the possible, gaps to flag, spoken extensions | none |
| 7 | [07-design-model-routes.md](07-design-model-routes.md) | Housekeeping: the design model's saved routes read back empty | none |

Every document has a **Decisions needed from you** section with numbered questions, options, my recommendation, and a line for your answer. Fill those in before the session builds anything.

Suggested order: 7 and 1 first, then 2, then 3, 4 and 5 (any order), with 6 at any time.

## Shared context

**Project.** A Just-in-Sequence seating demo on Vantiq. Namespace `VSA_IntegratedManufacturingOrchestration` on `https://dev.vantiq.com`. Repo root is `IntegratedManufacturingOrchestration/`. The script is `DemoInfo/demoflow.md`; terms are in `DemoInfo/glossary.md`.

**Where things are.**
- `Simulation/` Python simulator that plays the plant, Supplier A, Supplier B and the machines. See its README. It writes three SQLite databases in `Databases/data/` (plant MES, Supplier A, Supplier B) and publishes MQTT, REST and OPC UA feeds.
- `Vantiq/VSA_IntegratedManufacturingOrchestration/` the Vantiq resources as files (services, event handlers under `collaborationtypes/`, procedures under `procedures/`, sources, the design model under `designmodels/`).
- `Web/` the Vite and React dashboard. `Web/src/App.jsx` is most of it; `Web/src/services/updates.js` is the live UI-update subscription.
- `JdbcConnector/`, `OpcUaConnector/` local connectors that let Vantiq read and write the SQLite databases and read OPC UA.

**The Vantiq services.** `Tugger`, `PlantMES`, `Machines`, `Seating` (inbound feeds, normalized into `Events`), `Issue` (the damaged-seat case, a collaboration service), `UIUpdates` (single outbound stream for the UIs), `Board` (builds the sequence board by reading the three databases), `Events` (the normalized event type). The `Demo` service (`com.vantiqse.utils.Demo`, with `reset`) must NOT be in the design model.

**What is built for the damaged seat today.**
1. Simulator posts a failed quality scan to `Seating`, then 3 s later plays Supplier A placing a hold (`PartStatus HOLD`).
2. `Seating.SeatingData` joins the failed scan and the hold by VIN (10 s window) and publishes `OutboundDamagedSeating`.
3. The design model routes that to `Issue.InboundDamagedSeating`, which opens a collaboration per vehicle and calls `Issue.enrichDamagedSeating` (looks up the seat spec in the plant MES, reserves a spare in Supplier A's inventory by writing to its database).
4. The simulator plays the warehouse picker: it sees the reservation, takes the spare 4 s later (`REPLACEMENT_PICKED`), releases the hold 3 s after that (`HOLD_RELEASED`).
5. Those two events go `Seating` -> `Issue.InboundSeatingProgress` -> `Issue.progressUpdate`, which completes the collaboration on release.
6. Every step becomes a `OutboundUIUpdate` from `Issue`, routed to `UIUpdates.InboundUIUpdate`, then `UIUpdatePayload`, which the web app subscribes to.

**What is mock today (updated 2026-10-15).** The tugger fault (demo step 6) is a button-driven mock; the simulator sends the event but Vantiq does nothing with it. The build-order change (step 4) is built: see item 3. The buffer, risk tile and "Event to action" now come from Vantiq data (items 2). "Exceptions handled automatically" is still a count of pressed buttons. The "Need in" countdown now ticks from the board's timestamps and the simulator speed. The dashboard's UI-update subscription was fixed (`Web/src/services/updates.js`), so damaged-seat and build-order steps reach the log.

## Rules that apply to every session

- **Design pattern.** Services connect through the design model: a service publishes its own outbound event (`PublishToEventType`), the design model routes it to another service's inbound event. Clients subscribe to outbound events or call public procedures. Follow it.
- **Prefer visual event handlers** (the user will explain anything they need to).
- **The pattern for supplier systems.** Vantiq writes requests into each supplier's own tables (the reservation in Supplier A's inventory is the model), and the simulator plays the supplier acting on them. Vantiq does not place holds or move parts itself.
- **Collaborations are a write-behind cache.** Only work with the in-memory version (for example `Issue.ActiveCollabsGetCached`, `Issue.ActiveCollabsCloseAll`). Never read or change `system.collaborations` directly; it lags by up to 5 minutes. `Demo.reset` closes the Issue collaborations.
- **Secrets.** `.mcp.json` holds bearer tokens and is git-ignored. Connector tokens live in git-ignored `serverConfig/server.config` files. Never print them, hard-code them or commit them.
- **Do not start or stop** the simulator, the connectors or `npm run dev`. The user runs those. Say when a restart is needed.
- **Ask before writing to disk** if unclear. Commit only when asked, ending messages with the Co-Authored-By trailer the session gives you.
- **After creating Vantiq procedures**, check for compile errors on the procedure and its service, and ask the user about runtime verification.
- **Use they/them** for people unless pronouns are stated.

## Starting a session on one item

Open a new Claude Code session in the repo root and say: "Read DemoInfo/reviews/README.md and DemoInfo/reviews/<item>.md. Let's review it before building anything."
