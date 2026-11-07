#!/usr/bin/env bash
# gate.sh NAME CMD...  — runs one gate in the foreground, logs header + full output, appends a summary line.
cd /c/Users/Reem/Desktop/shopkhata
EV=docs/release/evidence/ops-01b-slice1-final-invariants
name=$1; shift
log=$EV/logs/$name.log
start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
{ echo "# gate: $name"; echo "# command: $*"; echo "# cwd: $(pwd)"; echo "# tree: $(bash "$(dirname "$0")/tree.sh")"; echo "# started: $start"; echo; } > "$log"
"$@" >> "$log" 2>&1; code=$?
end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sed -i 's/\x1b\[[0-9;]*[A-Za-z]//g' "$log"
{ echo; echo "# finished: $end"; echo "# exit: $code"; } >> "$log"
echo "$name|$start|$end|$code|$*" >> "$EV/logs/gates.tsv"
echo "gate $name exit $code"
