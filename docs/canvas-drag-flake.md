# The canvas drag flake: a load model, and two fixes that did not work

`package/ego-linux/README.md` describes the flake — the three canvas cases
intermittently count one stroke too many — and attributes it to
`driver/pointer.ts` `finishDragProbe`, which waits a fixed 50 ms for a trusted
`mouseup` and re-synthesises the whole drag if it has not seen one. When the
real events land late, the page gets both.

That description is right. What was missing is a way to *measure* it, without
which any fix is a guess. This note supplies one, and records two fixes that
looked reasonable and turned out not to work.

## The load model

The flake needs **parallelism**, not slowness. Pinned to a single core the work
serialises and it disappears; pinned to a few cores it appears in about half of
all runs.

| Condition | Runs failing |
|---|---|
| Idle, unpinned | 1 / 10 |
| `taskset -c 0` | 0 / 3 |
| `taskset -c 0-1` | 2 / 3 |
| `taskset -c 0-3` | 6 / 12 |

That single-core row is the useful one: it rules out "the machine is just slow"
and points at a race between the input path and the probe.

An earlier attempt to force the flake with twelve CPU busy-loops on a 32-thread
machine produced only 2/11 — barely above idle, and not enough to measure
against. Pure CPU pressure is the wrong lever.

Reproduce with `docs/experiments/canvas-flake-rate.sh`, run from
`package/ego-browser`.

## Fix attempt 1 — flush the renderer from the shim (rejected)

Hold the reply to `Input.dispatchMouseEvent` `mouseReleased` until a
`Runtime.evaluate` on the same session returns, on the theory that the evaluate
cannot run before the input task queued ahead of it, so the probe would always
find its `mouseup`.

Measured under identical load: **baseline 2/5 runs failing, this 4/5**. Worse.
The ordering assumption does not hold — input and script are not the same queue
in the way the theory needed — and the extra round-trip adds latency of its own.
Discarded, never pushed.

## Fix attempt 2 — poll for evidence before re-synthesising (no measurable effect)

Branch `fix/drag-probe-evidence` replaces the single 50 ms wait with three peeks
at 50 / 100 / 150 ms, synthesising only if none of them sees the release. This
is the fix `package/ego-linux/README.md` itself suggests, and it is a better
description of the intent than a fixed sleep.

Measured twice, interleaved with baseline so machine drift hits both arms:

| Load model | Baseline | Poll fix |
|---|---|---|
| 12 CPU busy-loops, 11 runs each | 2 / 11 | 3 / 11 |
| `taskset -c 0-3`, 12 runs each | 6 / 12 | 9 / 12 |

No improvement in either campaign, and a consistent lean the wrong way. At these
sample sizes the difference is not significant — 6/12 vs 9/12 is well inside
noise — so this is not evidence the change is harmful. It is evidence that it
does not fix the flake, which is what it would have to do to be worth carrying
as a patch to otherwise-unmodified upstream code.

A plausible reading is that the extra evaluate round-trips compete for the same
scarce cores the input path needs, so waiting longer also makes the thing being
waited for slower. That is a hypothesis, not a measurement.

## Where this leaves it

The flake is real, reproducible on demand, and still unfixed. Anything proposed
next should be measured with the script above at n ≥ 12 per arm, interleaved,
before it is described as a fix. Distinguishing 50 % from 25 % at conventional
significance needs roughly 50 runs per arm; the script takes a run count for
that reason.

Worth ruling out before trying another timing change: whether the doubled stroke
comes from the fallback at all. Counting how often `finishDragProbe` actually
takes its synthesise branch under this load model would settle it, and neither
attempt above checked.
