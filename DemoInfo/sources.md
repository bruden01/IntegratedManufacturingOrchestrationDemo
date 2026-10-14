# Data sources and how they land in Vantiq

The "Real world" columns describe what a customer would typically run. The "As built" columns describe what this demo does today.

## Sources

| Source | Protocol (real world) | Vantiq source type | How it arrives | Typical rate | Lands as |
|---|---|---|---|---|---|
| Plant MES | Message bus (Kafka, AMQP/RabbitMQ, JMS, or MQTT, depending on the plant) | Matching Vantiq source (Kafka, AMQP, MQTT) | Push. Vantiq subscribes to a topic or queue. | ~1–2 per minute | `BuildOrder` event, rev number and vehicle list |
| Supplier A, seating | REST | REST source | Pull (poll every 5–30 s) or push (supplier calls a Vantiq webhook) | ~5–15 per minute | `PartStatus` event, plus quality and inventory records |
| Supplier B, tugger fleet | MQTT for telemetry | MQTT source | Push. Vantiq subscribes to the fleet's topics. | ~1–10 per second | `TuggerTelemetry` and `TuggerFault` events |
| Supplier B, machine data | OPC UA | OPC UA source (usually an extension source or edge connector) | Subscription to node changes, or polling | Per node, ~1–5 s | Same tugger events |

## As built in this demo

All feeds are published by the simulator (`Simulation/simulator.py`) to the MQTT broker `public.vantiq.com:1883`.

| Source | Vantiq source | Topic | Rate in the simulator | Status |
|---|---|---|---|---|
| Plant MES | `com.vantiqse.imo.PlantMES` (MQTT) | `/vantiqse/imo/plantmes/buildorder` | One per vehicle (every 180 sim-seconds), plus revisions | Source created |
| Supplier A, seating | None yet | `/vantiqse/imo/suppliera/partstatus`, `/vantiqse/imo/suppliera/quality` | On each stage change or vision-check result | Published over MQTT as a stand-in for REST; no Vantiq source |
| Supplier B, tugger | `com.vantiqse.imo.SupplierBTugger` (MQTT) | `/vantiqse/imo/supplierb/tugger/#`, which covers `T1`, `T2`, `T3` × `telemetry` and `fault` | Telemetry every 2 sim-seconds per tugger; fault on event | Source created; routed by rule `OnTuggerMsg` to service `com.vantiqse.imo.Tugger` events `Telemetry` and `Fault` |
| Supplier B, OPC UA | Not built | Not applicable | Not applicable | To be discussed |

## What happens after a message lands

1. The source delivers the raw payload. Formats differ: JSON, a vendor schema, MQTT topics, OPC UA node values.
2. A Vantiq rule or app maps it into the shared event shape (the "Normalized event" box on the dashboard, with fields like `type`, `vin`, `station`, `source`, `ts`).
3. The normalized events update state (each seat set's status, its buffer to need time) and fire the logic that reacts: re-sequencing, replacement picks, tugger reassignment.

Today only step 1 and the routing part of step 2 exist, for the tugger feed. State and reactions are not built.

## Realism notes

- The plant MES varies the most. Many plants still use proprietary middleware or EDI. Treat "message bus" as a placeholder until you know what the customer runs.
- OPC UA is often reached through an edge gateway or the equipment vendor's broker, not directly from a cloud Vantiq instance. The gateway frequently republishes it over MQTT, so the tugger fleet may arrive as MQTT only.
- BACnet is a building automation protocol (HVAC, lighting, access control). It does not belong in this use case.
- The Vantiq source type names come from general knowledge of Vantiq. Confirm them against your namespace before showing them to a customer.
