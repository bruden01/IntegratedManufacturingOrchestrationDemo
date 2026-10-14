# Data sources and how they land in Vantiq

The "Real world" columns describe what a customer would typically run. The "As built" columns describe what this demo does today.

## Sources

| Source | Protocol (real world) | Vantiq source type | How it arrives | Typical rate | Lands as |
|---|---|---|---|---|---|
| Plant MES | Message bus (Kafka, AMQP/RabbitMQ, JMS, or MQTT, depending on the plant) | Matching Vantiq source (Kafka, AMQP, MQTT) | Push. Vantiq subscribes to a topic or queue. | ~1–2 per minute | `BuildOrder` event, rev number and vehicle list |
| Supplier A, seating | REST | REST source | Pull (poll every 5–30 s) or push (supplier calls a Vantiq webhook) | ~5–15 per minute | `PartStatus` event, plus quality and inventory records |
| Supplier B, tugger fleet | MQTT for telemetry | MQTT source | Push. Vantiq subscribes to the fleet's topics. | ~1–10 per second | `TuggerTelemetry` and `TuggerFault` events |
| Supplier B, machine data | OPC UA | OPC UA source (usually an extension source or edge connector) | Subscription to node changes, or polling | Per node, ~1–5 s | Machine readings (charger and conveyor state), separate from the tugger events |

## As built in this demo

The simulator (`Simulation/simulator.py`) produces every feed, each by the route its supplier would use: MQTT to the broker `public.vantiq.com:1883` (plant MES, tugger fleet), REST posted directly to Vantiq (seating), and an OPC UA server bridged by the connector in `OpcUaConnector/` (machine data).

| Source | Vantiq source | Topic | Rate in the simulator | Status |
|---|---|---|---|---|
| Plant MES | `com.vantiqse.imo.PlantMES` (MQTT) | `/vantiqse/imo/plantmes/buildorder` | One per vehicle (every 180 sim-seconds), plus revisions | Source created; consumed by app `com.vantiqse.imo.PlantMES.PlantMESData` into service `com.vantiqse.imo.PlantMES`; data verified arriving |
| Supplier A, seating | None: posted directly to service `com.vantiqse.imo.Seating` (REST) | `POST /api/v1/resources/services/com.vantiqse.imo.Seating/PartStatus` and `.../Quality` | On each stage change or vision-check result | Inbound events and visual handler apps (`Seating.PartStatus`, `Seating.Quality`) created; data verified arriving; nothing downstream of the handlers |
| Supplier B, tugger fleet | `com.vantiqse.imo.SupplierBTugger` (MQTT) | `/vantiqse/imo/supplierb/tugger/#`, which covers `T1`, `T2`, `T3` × `telemetry` and `fault` | Telemetry every 2 sim-seconds per tugger; fault on event | Source created; routed by rule `OnTuggerMsg` to service `com.vantiqse.imo.Tugger` events `Telemetry` and `Fault` |
| Supplier B, machine data | `com.vantiqse.imo.SupplierBMachines` (OPCUA extension source) | Server `opc.tcp://localhost:4840/imo`, namespace `urn:vantiqse:imo`, nodes `Machine.<CHG-1\|CHG-2\|CHG-3\|CONV-1>.<field>` (chargers: `State`, `ChargePct`, `FaultCode`; conveyor: `State`, `CartCount`, `FaultCode`) | Node updates on change, checked every 2 sim-seconds | Simulator hosts the OPC UA server; `OPCUA` source implementation and the source are created in the namespace; the connector in `OpcUaConnector/` (must be running locally) relays node changes; payloads verified arriving at the source; consumed by app `com.vantiqse.imo.Machines.MachineData` into service `com.vantiqse.imo.Machines`, which does no processing yet. Separate from the MQTT tugger fleet. Scenarios `charger` (CHG-2, E-17) and `conveyor` (CONV-1, J-03) fault these machines |

### Systems of record (SQLite, through the JDBC connector)

Records the reactions need that a stream cannot carry. Each is its own database, played by the simulator and reached from Vantiq through the connector in `JdbcConnector/`.

| System | Vantiq source | Database | Tables | Used for |
|---|---|---|---|---|
| Plant MES order database | `com.vantiqse.imo.PlantMESDB` | `plantmes.db` | `build_orders` | Order master: VIN, sequence, trim, seat spec, need time |
| Supplier A seating ERP/WMS | `com.vantiqse.imo.SupplierADB` | `supplier_a.db` | `seat_sets`, `seat_inventory` | Seat-set records; spare-seat lookup and reservation (bin B-14) |
| Supplier B fleet management | `com.vantiqse.imo.SupplierBDB` | `supplier_b.db` | `tuggers`, `assignments` | Tugger registry; which tugger carries which seat set |

Status: databases, sources and connector built. Nothing in Vantiq reads them yet.

## What happens after a message lands

1. The source delivers the raw payload. Formats differ: JSON, a vendor schema, MQTT topics, OPC UA node values.
2. A Vantiq rule or app maps it into the shared event shape (the "Normalized event" box on the dashboard, with fields like `type`, `vin`, `station`, `source`, `ts`).
3. The normalized events update state (each seat set's status, its buffer to need time) and fire the logic that reacts: re-sequencing, replacement picks, tugger reassignment.

Today step 1 exists for every feed. Step 2 exists only for the tugger feed (rule `OnTuggerMsg`); the other feeds land in service handlers as raw payloads. State and reactions are not built.

## Realism notes

- The plant MES varies the most. Many plants still use proprietary middleware or EDI. Treat "message bus" as a placeholder until you know what the customer runs.
- OPC UA is often reached through an edge gateway or the equipment vendor's broker, not directly from a cloud Vantiq instance. The gateway frequently republishes it over MQTT, so the tugger fleet may arrive as MQTT only.
- BACnet is a building automation protocol (HVAC, lighting, access control). It does not belong in this use case.
- The Vantiq source type names come from general knowledge of Vantiq. Confirm them against your namespace before showing them to a customer.
