# Codex × Ego Lite agent eval

This self-contained harness measures whether Codex can complete deterministic
browser tasks through `ego-browser`. It compares the agent-facing skill, not the
CDP implementation in isolation.

The suite records:

- task pass rate from server-side postconditions,
- wall-clock time,
- `ego-browser` heredoc rounds and total command executions,
- browser-command output characters,
- Codex input, cached-input, output, and reasoning token counts.

Each result also keeps a capped command/output trace for local fixture data, so
an unexpectedly expensive case can be diagnosed without rerunning it verbosely.

Each case runs in a fresh Codex session and a unique Ego Lite Task Space. Codex
works from an isolated temporary directory; the selected `SKILL.md` is embedded
in the prompt so baseline and candidate runs differ by one explicit input.

## Cases

| Case               | What it probes                                         |
| ------------------ | ------------------------------------------------------ |
| `semantic-form`    | labels, fill/check/click, visible success verification |
| `dynamic-rerender` | waiting and locator recovery after a DOM replacement   |
| `viewport-extract` | compact observation of a tall page                     |
| `new-tab`          | opening, switching to, and reading a new tab           |

## Usage

Preview first; this launches no model sessions:

```bash
node evals/agent-eval/run.mjs --dry
```

Run one inexpensive smoke case:

```bash
node evals/agent-eval/run.mjs \
  --label baseline \
  --case semantic-form \
  --runs 1 \
  --output /tmp/ego-agent-eval-baseline-smoke.json
```

Run a comparable A/B measurement. Pin the same model and use at least five runs
per case before treating pass-rate differences as meaningful:

```bash
node evals/agent-eval/run.mjs \
  --label baseline \
  --model <model> \
  --runs 5 \
  --output /tmp/ego-agent-eval-baseline.json

node evals/agent-eval/run.mjs \
  --label candidate \
  --model <same-model> \
  --skill /path/to/candidate/SKILL.md \
  --runs 5 \
  --output /tmp/ego-agent-eval-candidate.json

node evals/agent-eval/compare.mjs \
  /tmp/ego-agent-eval-baseline.json \
  /tmp/ego-agent-eval-candidate.json
```

The comparison refuses mismatched case sets or models. It reports pass-rate
change in percentage points and treats reductions in latency, browser rounds,
command output, and tokens as positive improvements. Skill SHA-256 values make
concurrent or accidental prompt changes visible.

Every case starts a separate Codex session, so a full `--runs 5` suite starts 20
sessions. Use `--dry` and a single-case smoke before a paid baseline.

## Verification

```bash
node --test evals/agent-eval/*.test.mjs
```
