# OPC UA connector

The bridge between the simulator's OPC UA server and Vantiq. It is the [Vantiq OPC UA extension source](https://github.com/Vantiq/vantiq-extension-sources/tree/master/opcuaSource), built unmodified from upstream.

```
Simulation/simulator.py  --OPC UA-->  this connector  --WebSocket-->  Vantiq source com.vantiqse.imo.SupplierBMachines
 (OPC UA server, :4840)               (runs locally)                  (dev.vantiq.com)
```

The simulator only hosts an OPC UA server. The connector connects to it, subscribes to the monitored nodes listed in the Vantiq source's configuration, and sends each change to Vantiq as a source message. Vantiq cannot reach `localhost`, which is why the connector runs on this machine and connects outward.

## Setup (once)

Needs Java 17+ and git.

```
./setup.sh
```

Clones upstream into `upstream/`, builds it, and unpacks it to `dist/`. Both are git-ignored.

Vantiq side, already done in namespace `VSA_IntegratedManufacturingOrchestration`: the `OPCUA` source implementation and the source `com.vantiqse.imo.SupplierBMachines` (`Vantiq/.../sourceimpls/OPCUA.json`, `.../sources/com/vantiqse/imo/SupplierBMachines.json`).

## Configure (once)

```
cp serverConfig/server.config.example serverConfig/server.config
```

Edit `serverConfig/server.config`: set `authToken` to a Vantiq access token for the `VSA_IntegratedManufacturingOrchestration` namespace. `targetServer` and `source` are already filled in. The file is git-ignored, so the token never enters the repo.

## Run

Start the simulator first, then the connector:

```
cd ../Simulation && .venv/bin/python simulator.py
cd ../OpcUaConnector && ./run.sh
```

The source shows as connected in Vantiq once the connector is up. `storage/` holds the connector's certificate store (git-ignored).
