# Systems of record

Three SQLite databases stand in for the suppliers' and plant's own systems. Each is a separate system with its own file; Vantiq reaches them through the JDBC connector in `../JdbcConnector`.

| File | System | Tables |
|---|---|---|
| `data/plantmes.db` | Plant MES (OEM order database) | `build_orders` |
| `data/supplier_a.db` | Supplier A seating ERP/WMS | `seat_sets`, `seat_inventory` |
| `data/supplier_b.db` | Supplier B fleet management | `tuggers`, `assignments` |

The schemas are in `schema/`. The simulator (`../Simulation/erp.py`) creates the files from them at startup and plays the part of each system: it keeps the rows current as the demo runs. Vantiq reads them on demand (for example a replacement-seat lookup in `seat_inventory`) and writes back for specific actions. `data/` is git-ignored and rebuilt on every simulator reset.
