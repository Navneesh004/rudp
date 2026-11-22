#!/usr/bin/env bash
# Benchmark RUDP against TCP over an emulated bad network.
#
# Starts two containers, adds packet loss and delay to the sender's interface
# with `tc netem`, and for each loss rate transfers the same file RUNS times
# with each protocol. Average throughput goes to results/results.csv, and one
# congestion-window trace goes to results/cwnd.csv.
#
# Usage:   bash bench/run.sh
# Options (environment variables):
#   LOSSES="0 1 2 5 10"  loss rates in percent
#   DELAY_MS=50          one-way delay added on the sender
#   RUNS=3               runs per protocol per loss rate
#   SIZE_MB=10           test file size
#   MODE=sr              RUDP mode: sr, gbn or saw
#   CWND_LOSS=1          loss rate at which to record the cwnd trace
#   KEEP=1               leave the containers running afterwards
set -euo pipefail
cd "$(dirname "$0")/.."

LOSSES="${LOSSES:-0 1 2 5 10}"
DELAY_MS="${DELAY_MS:-50}"
RUNS="${RUNS:-3}"
SIZE_MB="${SIZE_MB:-10}"
MODE="${MODE:-sr}"
CWND_LOSS="${CWND_LOSS:-1}"
PORT=9000
TIMEOUT_S=900
CSV=results/results.csv

dc() { docker compose "$@"; }
# Extract a field from a one-line JSON object without needing jq.
field() { grep -o "\"$1\":[^,}]*" | head -n1 | cut -d: -f2 | tr -d '"'; }
log() { printf '[bench] %s\n' "$*" >&2; }

cleanup() {
  dc exec -T sender tc qdisc del dev eth0 root 2>/dev/null || true
  [[ "${KEEP:-0}" == "1" ]] || dc down >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "building and starting containers"
dc up -d --build
dc exec -T sender sh -c "head -c ${SIZE_MB}M /dev/urandom > /tmp/test.bin"
EXPECTED=$(dc exec -T sender sha256sum /tmp/test.bin | cut -d' ' -f1)

mkdir -p results
echo "protocol,mode,loss_pct,delay_ms,size_mb,runs,throughput_mbps,throughput_std,retransmissions" > "$CSV"

set_netem() {
  dc exec -T sender tc qdisc replace dev eth0 root netem loss "${1}%" delay "${DELAY_MS}ms"
}

stop_receivers() {
  dc exec -T receiver sh -c "pkill -f 'recv.js' ; pkill -f 'tcp.js' ; rm -f /tmp/out*.bin /tmp/recv*.json" >/dev/null 2>&1 || true
}

# Wait for the receiver to write its JSON result and check its hash.
check_receiver() {
  local file=$1
  for _ in $(seq 1 50); do
    if dc exec -T receiver test -s "$file"; then
      local got
      got=$(dc exec -T receiver cat "$file" | field sha256)
      if [[ "$got" != "$EXPECTED" ]]; then
        log "HASH MISMATCH: expected $EXPECTED got $got"
        exit 1
      fi
      return 0
    fi
    sleep 0.2
  done
  log "receiver produced no result ($file)"
  exit 1
}

run_rudp() { # loss run -> prints sender JSON
  local extra=()
  if [[ "$1" == "$CWND_LOSS" && "$2" == "1" ]]; then extra=(--cwnd-log /tmp/cwnd.csv); fi
  stop_receivers
  dc exec -T -d receiver sh -c "node dist/src/cli/recv.js $PORT /tmp/out.bin --json > /tmp/recv.json 2>/dev/null"
  sleep 1
  timeout "$TIMEOUT_S" docker compose exec -T sender \
    node dist/src/cli/send.js receiver "$PORT" /tmp/test.bin --mode "$MODE" --json "${extra[@]}"
  check_receiver /tmp/recv.json
  if [[ ${#extra[@]} -gt 0 ]]; then dc cp sender:/tmp/cwnd.csv results/cwnd.csv >&2; fi
}

run_tcp() {
  stop_receivers
  dc exec -T -d receiver sh -c "node dist/baseline/tcp.js recv $PORT /tmp/out_tcp.bin --json > /tmp/recv_tcp.json 2>/dev/null"
  sleep 1
  timeout "$TIMEOUT_S" docker compose exec -T sender \
    node dist/baseline/tcp.js send receiver "$PORT" /tmp/test.bin --json
  check_receiver /tmp/recv_tcp.json
}

# mean and population standard deviation of the numbers on stdin
stats() { awk '{s+=$1; ss+=$1*$1; n++} END {m=s/n; v=ss/n-m*m; if (v<0) v=0; printf "%.3f,%.3f", m, sqrt(v)}'; }

for loss in $LOSSES; do
  set_netem "$loss"
  for proto in rudp tcp; do
    speeds=()
    retx=()
    for run in $(seq 1 "$RUNS"); do
      if [[ "$proto" == "rudp" ]]; then out=$(run_rudp "$loss" "$run"); else out=$(run_tcp); fi
      mbps=$(echo "$out" | field mbps)
      r=$(echo "$out" | field retransmissions)
      log "$proto loss=${loss}% run=$run: ${mbps} MB/s, retransmissions=${r}"
      speeds+=("$mbps")
      retx+=("$r")
    done
    avg=$(printf '%s\n' "${speeds[@]}" | stats)
    if [[ "$proto" == "rudp" ]]; then
      r_avg=$(printf '%s\n' "${retx[@]}" | awk '{s+=$1;n++} END {printf "%.0f", s/n}')
      mode=$MODE
    else
      r_avg=""
      mode=""
    fi
    echo "$proto,$mode,$loss,$DELAY_MS,$SIZE_MB,$RUNS,$avg,$r_avg" >> "$CSV"
  done
done

log "done: $CSV"
cat "$CSV"
log "plot with: python bench/plot.py"
