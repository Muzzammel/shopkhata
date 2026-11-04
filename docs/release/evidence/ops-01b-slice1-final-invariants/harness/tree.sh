#!/usr/bin/env bash
# Prints the git tree id of the working tree EXCLUDING the evidence directory (what the gates tested).
cd /c/Users/Reem/Desktop/shopkhata
EV=docs/release/evidence/ops-01b-slice1-final-invariants
IDX=$(mktemp); rm -f "$IDX"
GIT_INDEX_FILE="$IDX" git read-tree HEAD
GIT_INDEX_FILE="$IDX" git add -A -- . ":(exclude)$EV" 2>/dev/null
GIT_INDEX_FILE="$IDX" git write-tree
rm -f "$IDX"
