# JDBC connector

The bridge between Vantiq and the SQLite systems of record in `../Databases`. It is the [Vantiq JDBC extension source](https://github.com/Vantiq/vantiq-extension-sources/tree/master/jdbcSource), built unmodified from upstream except that `setup.sh` adds the SQLite JDBC driver as a dependency.

```
Simulation/simulator.py --writes--> Databases/data/*.db <--JDBC-- this connector --WebSocket--> Vantiq sources
 (plays each system)                 (the systems of record)       (runs locally)               com.vantiqse.imo.PlantMESDB / SupplierADB / SupplierBDB
```

One connector process serves all three sources. Vantiq cannot reach files on this machine, which is why the connector runs here and connects outward.

| Vantiq source | Database | Tables |
|---|---|---|
| `com.vantiqse.imo.PlantMESDB` | `plantmes.db` | `build_orders` |
| `com.vantiqse.imo.SupplierADB` | `supplier_a.db` | `seat_sets`, `seat_inventory` |
| `com.vantiqse.imo.SupplierBDB` | `supplier_b.db` | `tuggers`, `assignments` |

## Setup (once)

Needs Java 17+ and git.

```
./setup.sh
cp serverConfig/server.config.example serverConfig/server.config   # then set authToken
```

`setup.sh` clones upstream into `upstream/`, builds it, and unpacks it to `dist/`; both are git-ignored, as is `server.config`.

Vantiq side, already done in namespace `VSA_IntegratedManufacturingOrchestration`: the `JDBC` source implementation and the three sources (`Vantiq/.../sourceimpls/JDBC.json`, `.../sources/com/vantiqse/imo/*DB.json`).

## Run

Start the simulator first (it creates and maintains the databases), then the connector:

```
cd ../Simulation && .venv/bin/python simulator.py
cd ../JdbcConnector && ./run.sh
```

Run it from this folder: the database paths in the source configurations (`jdbc:sqlite:../Databases/data/...`) are relative.

## Using the sources from VAIL

Read on demand:

```
SELECT * FROM SOURCE com.vantiqse.imo.SupplierADB WITH query = "SELECT * FROM seat_inventory WHERE seat_spec = 'Cloth · Black' AND on_hand - reserved > 0"
```

Write:

```
PUBLISH {query: "UPDATE seat_inventory SET reserved = reserved + 1 WHERE bin = 'B-14'"} TO SOURCE com.vantiqse.imo.SupplierADB
```

A source configuration can also set `pollTime` and `pollQuery` to push query results to Vantiq as notifications; none of the three does yet.
