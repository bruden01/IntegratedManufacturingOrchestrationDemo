#!/usr/bin/env bash
# Run the connector: it opens the SQLite databases and relays Vantiq queries, publishes and polls.
# One process serves all three sources; connection settings come from serverConfig/server.config.
# Run from this folder so the relative database paths in the source configurations resolve.
set -euo pipefail
cd "$(dirname "$0")"

[ -x dist/jdbcSource/bin/jdbcSource ] || { echo "Run ./setup.sh first" >&2; exit 1; }
[ -f serverConfig/server.config ] || { echo "Create serverConfig/server.config from serverConfig/server.config.example" >&2; exit 1; }
[ -f ../Databases/data/plantmes.db ] || { echo "Start the simulator first: it creates the databases" >&2; exit 1; }

exec dist/jdbcSource/bin/jdbcSource serverConfig/server.config
