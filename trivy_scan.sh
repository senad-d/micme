#!/usr/bin/env bash

set -euo pipefail

# Local filesystem scan for this repository. This script intentionally does not
# use Docker; it requires the Trivy CLI to be installed on the host.

# Match workflow behavior: use .trivyignore when present.
USE_TRIVY_IGNORE=true

# Configurable variables with sensible defaults (can be overridden via environment variables)
TRIVY_SEVERITY="${TRIVY_SEVERITY:-CRITICAL,HIGH,MEDIUM}"
TRIVY_SCANNERS="${TRIVY_SCANNERS:-vuln,secret,misconfig}"
TRIVY_VULN_TYPE="${TRIVY_VULN_TYPE:-library}"
TRIVY_PKG_TYPES="${TRIVY_PKG_TYPES:-$TRIVY_VULN_TYPE}"
TRIVY_EXIT_CODE="${TRIVY_EXIT_CODE:-1}"
TRIVY_REPORT="${TRIVY_REPORT:-trivy-reports/trivy.json}"
TRIVY_TABLE_REPORT="${TRIVY_TABLE_REPORT:-trivy-reports/trivy.txt}"
TRIVY_SKIP_DB_UPDATE="${TRIVY_SKIP_DB_UPDATE:-false}"
TRIVY_SKIP_JAVA_DB_UPDATE="${TRIVY_SKIP_JAVA_DB_UPDATE:-false}"
TRIVY_DISABLE_VEX_NOTICE="${TRIVY_DISABLE_VEX_NOTICE:-true}"
TRIVY_CACHE_DIR="${TRIVY_CACHE_DIR:-.trivycache}"
TRIVY_SCAN_TARGET="${TRIVY_SCAN_TARGET:-.}"
TRIVY_SKIP_DIRS="${TRIVY_SKIP_DIRS:-.git,node_modules,trivy-reports,.trivycache}"
TRIVY_IGNORE_UNFIXED="${TRIVY_IGNORE_UNFIXED:-true}"
TRIVY_INCLUDE_DEV_DEPS="${TRIVY_INCLUDE_DEV_DEPS:-true}"
TRIVY_OFFLINE_SCAN="${TRIVY_OFFLINE_SCAN:-false}"

print_help() {
  cat <<EOF
Usage: $0 [OPTIONS]

Scan this repository's source tree with the local Trivy CLI using filesystem mode.
No Docker daemon or container image build is required.

Options:
  -h, --help              Show this help message and exit.
  -i, --ignore            Force use of .trivyignore from repo root (default behavior).
  --no-ignore             Disable use of .trivyignore.
  -t, --target PATH       Path to scan, relative to repo root unless absolute (default: .).
  --target PATH           Same as -t.

Environment variables (with defaults):
  TRIVY_SEVERITY          Severity levels to report (default: CRITICAL,HIGH,MEDIUM)
  TRIVY_SCANNERS          Scanners to run (default: vuln,secret,misconfig)
  TRIVY_VULN_TYPE         Deprecated compatibility input; used as fallback for TRIVY_PKG_TYPES.
  TRIVY_PKG_TYPES         Package types for vulnerability scans (default: library)
  TRIVY_EXIT_CODE         Exit code Trivy uses on findings (default: 1)
  TRIVY_REPORT            JSON report path (default: trivy-reports/trivy.json)
  TRIVY_TABLE_REPORT      Table report path (default: trivy-reports/trivy.txt)
  TRIVY_SKIP_DB_UPDATE    Skip Trivy DB update; requires an existing cache (default: false)
  TRIVY_SKIP_JAVA_DB_UPDATE Skip Trivy Java DB update; requires an existing cache if needed (default: false)
  TRIVY_DISABLE_VEX_NOTICE Disable VEX notice (default: true)
  TRIVY_CACHE_DIR         Persistent cache dir for Trivy DB (default: .trivycache)
  TRIVY_SCAN_TARGET       Path to scan, relative to repo root unless absolute (default: .)
  TRIVY_SKIP_DIRS         Comma-separated dirs to skip (default: .git,node_modules,trivy-reports,.trivycache)
  TRIVY_IGNORE_UNFIXED    Show only fixed vulnerabilities (default: true)
  TRIVY_INCLUDE_DEV_DEPS  Include npm/yarn/gradle dev dependencies (default: true)
  TRIVY_OFFLINE_SCAN      Do not issue API requests to identify dependencies (default: false)

Requirements:
  - Trivy CLI must be installed and available in PATH.
    On macOS: brew install trivy
EOF
}

is_true() {
  case "${1:-}" in
    true|TRUE|True|1|yes|YES|Yes|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"

resolve_path() {
  local path_value="$1"
  if [[ "$path_value" = /* ]]; then
    printf '%s\n' "$path_value"
  else
    printf '%s\n' "$REPO_ROOT/$path_value"
  fi
}

# Parse CLI arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--ignore)
      USE_TRIVY_IGNORE=true
      shift
      ;;
    --no-ignore)
      USE_TRIVY_IGNORE=false
      shift
      ;;
    -t|--target)
      if [[ $# -lt 2 ]]; then
        echo "Error: $1 requires a path argument." >&2
        exit 1
      fi
      TRIVY_SCAN_TARGET="$2"
      shift 2
      ;;
    --target=*)
      TRIVY_SCAN_TARGET="${1#*=}"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [-h|--help] [-i|--ignore] [--no-ignore] [-t|--target PATH]" >&2
      exit 1
      ;;
  esac
done

# Ensure Trivy CLI is available. Docker is not required for filesystem scans.
if ! command -v trivy >/dev/null 2>&1; then
  echo "Error: Trivy CLI is not installed or not available in PATH." >&2
  echo "Install it first (macOS: brew install trivy), then re-run this script." >&2
  exit 127
fi

SCAN_TARGET_PATH="$(resolve_path "$TRIVY_SCAN_TARGET")"
JSON_REPORT_PATH="$(resolve_path "$TRIVY_REPORT")"
TABLE_REPORT_PATH="$(resolve_path "$TRIVY_TABLE_REPORT")"
TRIVY_CACHE_PATH="$(resolve_path "$TRIVY_CACHE_DIR")"

if [[ ! -e "$SCAN_TARGET_PATH" ]]; then
  echo "Error: scan target does not exist: $SCAN_TARGET_PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$JSON_REPORT_PATH")" "$(dirname "$TABLE_REPORT_PATH")" "$TRIVY_CACHE_PATH"

TRIVY_IGNORE_ARGS=()
TRIVY_IGNORE_FILE="$REPO_ROOT/.trivyignore"
if [[ "$USE_TRIVY_IGNORE" == true ]]; then
  if [[ -f "$TRIVY_IGNORE_FILE" ]]; then
    echo "Using .trivyignore from: $TRIVY_IGNORE_FILE"
    TRIVY_IGNORE_ARGS=("--ignorefile" "$TRIVY_IGNORE_FILE")
  else
    echo ".trivyignore was enabled, but no file found at repo root. Proceeding without ignore rules."
  fi
else
  echo "Not using .trivyignore."
fi

SKIP_DIR_ARGS=()
if [[ -n "$TRIVY_SKIP_DIRS" ]]; then
  IFS=',' read -r -a SKIP_DIR_VALUES <<< "$TRIVY_SKIP_DIRS"
  for raw_skip_dir in "${SKIP_DIR_VALUES[@]}"; do
    skip_dir="$(trim "$raw_skip_dir")"
    if [[ -n "$skip_dir" ]]; then
      SKIP_DIR_ARGS+=("--skip-dirs" "$(resolve_path "$skip_dir")")
    fi
  done
fi

TRIVY_GLOBAL_ARGS=("--cache-dir" "$TRIVY_CACHE_PATH")
TRIVY_SCAN_ARGS=(
  "fs"
  "--severity" "$TRIVY_SEVERITY"
  "--scanners" "$TRIVY_SCANNERS"
  "--pkg-types" "$TRIVY_PKG_TYPES"
  "--exit-code" "$TRIVY_EXIT_CODE"
)

if is_true "$TRIVY_SKIP_DB_UPDATE"; then
  TRIVY_SCAN_ARGS+=("--skip-db-update")
fi

if is_true "$TRIVY_SKIP_JAVA_DB_UPDATE"; then
  TRIVY_SCAN_ARGS+=("--skip-java-db-update")
fi

if is_true "$TRIVY_IGNORE_UNFIXED"; then
  TRIVY_SCAN_ARGS+=("--ignore-unfixed")
fi

if is_true "$TRIVY_INCLUDE_DEV_DEPS"; then
  TRIVY_SCAN_ARGS+=("--include-dev-deps")
fi

if is_true "$TRIVY_OFFLINE_SCAN"; then
  TRIVY_SCAN_ARGS+=("--offline-scan")
fi

export TRIVY_DISABLE_VEX_NOTICE

cd "$REPO_ROOT"

echo "Using local Trivy CLI: $(command -v trivy)"
echo "Trivy severity filter: ${TRIVY_SEVERITY}"
echo "Trivy scanners: ${TRIVY_SCANNERS}"
echo "Trivy pkg types: ${TRIVY_PKG_TYPES}"
echo "Trivy exit code on findings: ${TRIVY_EXIT_CODE}"
echo "Trivy skip DB update: ${TRIVY_SKIP_DB_UPDATE}"
echo "Trivy skip Java DB update: ${TRIVY_SKIP_JAVA_DB_UPDATE}"
echo "Trivy disable VEX notice: ${TRIVY_DISABLE_VEX_NOTICE}"
echo "Trivy include dev deps: ${TRIVY_INCLUDE_DEV_DEPS}"
echo "Trivy offline scan: ${TRIVY_OFFLINE_SCAN}"
echo "Trivy cache path: ${TRIVY_CACHE_PATH}"
echo "Trivy scan target: ${SCAN_TARGET_PATH}"
echo "Trivy table report path: ${TABLE_REPORT_PATH}"
echo "Trivy json report path: ${JSON_REPORT_PATH}"
echo "Docker usage: disabled (filesystem scan)"

# These script configuration names intentionally keep backward compatibility with
# the old Docker wrapper, but some collide with Trivy's own TRIVY_* environment
# bindings (notably TRIVY_REPORT). Keep the resolved values above and prevent the
# child Trivy process from interpreting script-only variables as CLI flags.
unset TRIVY_REPORT TRIVY_TABLE_REPORT TRIVY_SCAN_TARGET TRIVY_SKIP_DIRS TRIVY_VULN_TYPE

set +e

# Primary run (table format)
trivy "${TRIVY_GLOBAL_ARGS[@]}" \
  "${TRIVY_SCAN_ARGS[@]}" \
  --format table \
  --output "$TABLE_REPORT_PATH" \
  "${TRIVY_IGNORE_ARGS[@]}" \
  "${SKIP_DIR_ARGS[@]}" \
  "$SCAN_TARGET_PATH"
TABLE_RESULT=$?

# Secondary run (json format)
trivy "${TRIVY_GLOBAL_ARGS[@]}" \
  "${TRIVY_SCAN_ARGS[@]}" \
  --format json \
  --output "$JSON_REPORT_PATH" \
  "${TRIVY_IGNORE_ARGS[@]}" \
  "${SKIP_DIR_ARGS[@]}" \
  "$SCAN_TARGET_PATH"
JSON_RESULT=$?

set -e

if [[ $JSON_RESULT -ne 0 && $JSON_RESULT -ne $TRIVY_EXIT_CODE ]]; then
  echo "Error: Trivy JSON filesystem scan failed with exit code $JSON_RESULT." >&2
  echo "Table report (if generated) is at: $TABLE_REPORT_PATH" >&2
  echo "JSON report (if generated) is at: $JSON_REPORT_PATH" >&2
  exit "$JSON_RESULT"
fi

if [[ $TABLE_RESULT -eq 0 ]]; then
  echo "Trivy filesystem scan completed successfully. No findings with severity [$TRIVY_SEVERITY] were found."
  echo "Report available at: $JSON_REPORT_PATH"
  echo "Table report available at: $TABLE_REPORT_PATH"
  exit 0
elif [[ $TABLE_RESULT -eq $TRIVY_EXIT_CODE ]]; then
  echo "Trivy filesystem scan detected findings with severity [$TRIVY_SEVERITY]."
  echo "Report available at: $JSON_REPORT_PATH"
  echo "Table report available at: $TABLE_REPORT_PATH"
  exit "$TRIVY_EXIT_CODE"
else
  echo "Error: Trivy filesystem scan failed with exit code $TABLE_RESULT." >&2
  echo "Report (if generated) is at: $JSON_REPORT_PATH" >&2
  echo "Table report (if generated) is at: $TABLE_REPORT_PATH" >&2
  exit "$TABLE_RESULT"
fi
