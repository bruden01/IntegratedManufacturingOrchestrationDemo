#!/usr/bin/env bash
# Run the connector: it connects to the OPC UA server (the simulator) and to Vantiq,
# and relays node changes to the Vantiq source.
# Connection settings come from serverConfig/server.config (copy the .example file).
set -euo pipefail
cd "$(dirname "$0")"

[ -x dist/opcuaSource/bin/opcuaSource ] || { echo "Run ./setup.sh first" >&2; exit 1; }
[ -f serverConfig/server.config ] || { echo "Create serverConfig/server.config from serverConfig/server.config.example" >&2; exit 1; }

mkdir -p storage
exec dist/opcuaSource/bin/opcuaSource
