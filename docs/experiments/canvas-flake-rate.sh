#!/bin/sh
# Measure the canvas drag flake rate for whichever ego-browser is on PATH.
#
# The three canvas cases intermittently count one stroke too many because
# driver/pointer.ts re-synthesises a drag whose trusted mouseup it has not seen
# yet. On an idle machine that is ~1 run in 10, which is far too rare to judge a
# fix by. Pinning to a few cores raises it to roughly half of all runs without
# changing anything else, so a difference between two builds becomes visible at
# a sample size you can actually afford.
#
# Pin to a FEW cores, not one: the race needs parallelism. At -c 0 the work
# serialises and the flake disappears entirely (0/3 measured), which makes a
# single core useless as a load model.
#
#   Idle, unpinned   1/10 runs fail
#   taskset -c 0     0/3
#   taskset -c 0-1   2/3
#   taskset -c 0-3   ~6/12
#
# Usage, from package/ego-browser:
#   sh ../../docs/experiments/canvas-flake-rate.sh [runs] [cores]
#   PATH=/path/to/other/shim:$PATH sh ../../docs/experiments/canvas-flake-rate.sh
#
# Compare two builds by running it once per build and comparing the rates.
# Interleave the two if the machine is doing anything else: rates drift with
# machine state, and a back-to-back batch comparison inverted on us once.

set -eu

RUNS=${1:-12}
CORES=${2:-0-3}
STATE=$(mktemp -d "${TMPDIR:-/tmp}/canvas-flake.XXXXXX")
trap 'rm -rf "$STATE"' EXIT

export EGO_BROWSER_REAL_E2E_ONLY="canvas draw single stroke,canvas draw multiple strokes,canvas draw zigzag path"
export XDG_DATA_HOME="$STATE/data"
export XDG_STATE_HOME="$STATE/state"
mkdir -p "$XDG_DATA_HOME" "$XDG_STATE_HOME"

command -v taskset >/dev/null 2>&1 || {
	echo "taskset is required (util-linux)" >&2
	exit 1
}

echo "ego-browser: $(command -v ego-browser)"
echo "runs: $RUNS   pinned to cores: $CORES"

failed=0
i=1
while [ "$i" -le "$RUNS" ]; do
	passed=$(taskset -c "$CORES" npm run e2e 2>&1 |
		sed -n 's/^  Passed:[[:space:]]*\([0-9]*\).*/\1/p' | head -n 1)
	# An unparseable result means the run did not complete cleanly; count it as
	# a failure rather than silently dropping it from the denominator.
	if [ "$passed" != "4" ]; then
		failed=$((failed + 1))
		echo "  run $i: FAIL (${passed:-no result}/4)"
	else
		echo "  run $i: ok"
	fi
	i=$((i + 1))
done

echo "flake rate: $failed/$RUNS"
