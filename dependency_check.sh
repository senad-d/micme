#!/bin/bash

DC_VERSION="latest"
DC_DIRECTORY=$HOME/OWASP-Dependency-Check
DC_PROJECT="dependency-check scan: $(pwd)"
DATA_DIRECTORY="$DC_DIRECTORY/data"
CACHE_DIRECTORY="$DC_DIRECTORY/data/cache"
NVD_API_KEY="${NVD_API_KEY:-}"
NVD_API_ARGS=()
if [[ -n "$NVD_API_KEY" ]]; then
  NVD_API_ARGS=(--nvdApiKey "$NVD_API_KEY")
else
  echo "NVD_API_KEY is not set; Dependency-Check may use slower public NVD rate limits."
fi

SUPPRESSION_ARGS=()
if [[ -f "dependency-check-suppression.xml" ]]; then
  SUPPRESSION_ARGS=(--suppression "dependency-check-suppression.xml")
fi

UPDATE_ONLY=false
if [[ "${1:-}" == "--update" ]]; then
  UPDATE_ONLY=true
fi

if [ ! -d "$DATA_DIRECTORY" ]; then
    echo "Initially creating persistent directory: $DATA_DIRECTORY"
    mkdir -p "$DATA_DIRECTORY"
fi
if [ ! -d "$CACHE_DIRECTORY" ]; then
    echo "Initially creating persistent directory: $CACHE_DIRECTORY"
    mkdir -p "$CACHE_DIRECTORY"
fi

docker pull owasp/dependency-check:$DC_VERSION

if [ "$UPDATE_ONLY" = true ]; then
  echo "Running Dependency-Check in update-only mode (no scan)..."
  docker run --rm \
      -e user=$USER \
      -u $(id -u ${USER}):$(id -g ${USER}) \
      --volume "$(pwd)":/src:z \
      --volume "$DATA_DIRECTORY":/usr/share/dependency-check/data:z \
      --volume "$(pwd)/odc-reports":/report:z \
      owasp/dependency-check:$DC_VERSION \
      --updateonly \
      "${NVD_API_ARGS[@]}"
else
  echo "Running full Dependency-Check scan..."
  docker run --rm \
      -e user=$USER \
      -u $(id -u ${USER}):$(id -g ${USER}) \
      --volume "$(pwd)":/src:z \
      --volume "$DATA_DIRECTORY":/usr/share/dependency-check/data:z \
      --volume "$(pwd)/odc-reports":/report:z \
      owasp/dependency-check:$DC_VERSION \
      --scan /src \
      --format "ALL" \
      --project "$DC_PROJECT" \
      --out /report \
      "${SUPPRESSION_ARGS[@]}" \
      "${NVD_API_ARGS[@]}"
fi
