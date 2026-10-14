#!/usr/bin/env bash
# Build the Vantiq JDBC extension source (the connector) with the SQLite driver into ./dist.
# Needs Java 17+ and git. Upstream's Gradle wrapper downloads Gradle itself.
set -euo pipefail
cd "$(dirname "$0")"

SQLITE_JDBC_VERSION=3.46.1.3

[ -d upstream ] || git clone --depth 1 https://github.com/Vantiq/vantiq-extension-sources.git upstream

# The start script only puts the jars Gradle knows about on the classpath, so the driver has to be a dependency.
if ! grep -q sqlite-jdbc upstream/jdbcSource/build.gradle; then
  cat >> upstream/jdbcSource/build.gradle <<GRADLE

dependencies {
    runtimeOnly 'org.xerial:sqlite-jdbc:${SQLITE_JDBC_VERSION}'
}
GRADLE
fi

(cd upstream && ./gradlew :jdbcSource:assemble -x test --console=plain)

rm -rf dist && mkdir dist
unzip -q upstream/jdbcSource/build/distributions/jdbcSource.zip -d dist
echo "Built: $(pwd)/dist/jdbcSource/bin/jdbcSource"
