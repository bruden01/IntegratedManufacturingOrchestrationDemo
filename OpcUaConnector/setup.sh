#!/usr/bin/env bash
# Build the Vantiq OPC UA extension source (the connector) into ./dist.
# Needs Java 17+ and git. Upstream's Gradle wrapper downloads Gradle itself.
set -euo pipefail
cd "$(dirname "$0")"

[ -d upstream ] || git clone --depth 1 https://github.com/Vantiq/vantiq-extension-sources.git upstream
(cd upstream && ./gradlew :opcuaSource:assemble -x test --console=plain)

rm -rf dist && mkdir dist
unzip -q upstream/opcuaSource/build/distributions/opcuaSource.zip -d dist
echo "Built: $(pwd)/dist/opcuaSource/bin/opcuaSource"
