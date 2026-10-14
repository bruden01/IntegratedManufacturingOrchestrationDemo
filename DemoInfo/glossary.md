# Glossary

Plain-language definitions of the terms, systems, and protocols on the dashboard. The three data sources come first, since those are the ones the audience asks about most.

## The three data sources

### Plant MES (the automaker's factory)
**What it is:** The automaker's Manufacturing Execution System. It runs the assembly plant floor and knows which vehicle is being built in which order.
**What it sends:** The **build-order broadcast**: the sequence of vehicles about to hit the line, with trim level and options (for example, "heated vinyl seats, black").
**How it connects:** A message bus. The plant publishes a message whenever the schedule is created or changed, such as rev 117 becoming rev 118.
**Why it matters:** Everything starts here. Every other system has to react when this sequence changes.

### Supplier A · Seating (the seat maker)
**What it is:** The company that builds the seats and ships them to the plant. Here it stands for the seating supplier's own MES and ERP systems.
**What it sends:** Where each seat set is in the process (picked, sequenced, staged), quality scan results (such as a vision check flagging a torn bolster), and inventory levels in its buffers.
**How it connects:** **REST**, a standard web API. Vantiq either calls the supplier's API on a schedule or receives its webhooks. The supplier's systems are never replaced.
**Why it matters:** This is the plant's view into a different company's operations. Normally that information arrives late, by phone or email.

### Supplier B · Tugger fleet (the vehicles that move parts)
**What it is:** A fleet of **tuggers**, small tow vehicles that pull carts of parts from the supplier park to the assembly line. Here the fleet is run by a logistics provider, a separate company from the seat maker.
**What it sends:** Each tugger's position, what it is carrying, and **fault codes** (for example, drive fault E-41).
**How it connects:** **MQTT** and **OPC UA**, the protocols used by industrial equipment and sensors (see below).
**Why it matters:** The seats can be built perfectly and still arrive late if the tugger carrying them breaks down.

## JIS (Just-in-Sequence)

**What it is:** A delivery method where parts arrive at the assembly line in the exact order the vehicles will be built, not just in the right quantity. If vehicle 2044 needs black cloth seats and 2045 needs black heated vinyl, the seat sets arrive in that order.

**JIS vs. JIT:** Just-in-Time (JIT) delivers the right parts at the right time, in bulk. JIS goes further and delivers them in build order, so line workers take the next item without sorting. JIS is used for parts that vary by vehicle and are bulky or expensive to stock, such as seats, bumpers, cockpits, and wheels.

**How it works for seating:** The plant broadcasts the build order. The seat supplier builds each seat set to match, loads the sets in sequence, and ships them to arrive minutes before they are needed. Seats are often built within a few hours of installation.

**Why it's fragile:** There is very little inventory between the supplier and the line. A wrong, damaged, late, or out-of-order seat set can stop the line, and every minute of stoppage costs money. This is the problem the demo addresses.

**Where it shows up in the demo:** The title "JIS Control Tower", the sequence board, and the "Need in" countdowns.

## Protocols

| Term | What it is |
|---|---|
| **REST** | The common way web systems exchange data over HTTP. Typical for business software such as MES, ERP, and supplier portals. |
| **MQTT** | A lightweight publish/subscribe messaging protocol for devices and sensors. A device publishes "I'm at position X" and anyone subscribed receives it. |
| **OPC UA** | The industrial standard for reading data from machines and controllers (PLCs, vehicles, conveyors). It is vendor-neutral. |
| **Message bus** | A shared channel where systems publish messages and other systems subscribe to them. |
| **Normalized event** | Vantiq converts each source's format into one common event shape, so the rules don't care whether data came from REST, MQTT, or the bus. This is the "Normalized event" box on the dashboard. |

## Manufacturing terms

| Term | What it means |
|---|---|
| **JIS (Just-in-Sequence)** | Parts are delivered to the line in the exact order the vehicles will be built, not just in the right quantity. |
| **Build order / sequence** | The ordered list of vehicles going down the line. "Rev 117 → 118" is a revision of that list. |
| **Seat set** | All the seats for one vehicle, matched to that vehicle's trim and color. |
| **Line-side** | The point on the assembly line where parts are installed. |
| **Need time / "Need in"** | The time left until a seat set must be at line-side. |
| **Buffer (slack)** | The margin between when a seat set will arrive and when it is needed. The "tightest buffer" KPI is the smallest margin across all seat sets in flight. |
| **Line stop** | The assembly line halts because a part is missing or wrong. Every minute has a cost (set on the Settings page). |
| **VIN** | Vehicle Identification Number, the unique ID of each vehicle. |
| **Supplier park** | A group of suppliers next to the plant, so parts have a short trip to the line. |

## Seat set stages (Park flow)

1. **Queued:** the order is known, nothing has happened yet.
2. **Picking:** components are being collected.
3. **Sequenced:** the seat set is built and placed in the correct vehicle order.
4. **Staged:** the set is waiting at the dock or staging area.
5. **On tugger:** the set is on its way to the line.
6. **Line-side:** the set has arrived and is ready to install.

## Dashboard terms

| Term | What it means |
|---|---|
| **SEQ-2, SEQ-3** | Sequencing stations in the supplier's facility. |
| **Buffer B-14** | A stock area holding spare seats. When a seat is damaged, a replacement is reserved from here. |
| **T1, T3** | Individual tuggers in the fleet. |
| **Line-stop risk (Low / Watch)** | **Watch** appears when the tightest buffer falls below 10 minutes. |
| **Event to action** | The time from an event arriving to Vantiq's response being issued. |
| **Exceptions handled automatically** | Disruptions Vantiq resolved without a person. |
