# myzgoal

`/goal` for [PI Agent](https://github.com/earendil-works/pi-mono) — set a completion condition and pi keeps working across turns until it's met.

Port of Claude Code's [`/goal` command](https://code.claude.com/docs/en/goal) as a PI extension.

## How it works

```text
/goal <condition> ──► goal recorded ──► turn starts immediately, condition as directive
                                                       │
every settled run ──► evaluator (separate small model) ─┤
        │ verdict                                       │
        ├─ not_yet ──► feedback becomes next-turn guidance, loop continues
        ├─ met ──────► goal cleared, achievement recorded in the transcript
        └─ impossible ► goal cleared, failure reason recorded
```

The key architectural idea (same as Claude Code): **the model doing the work no longer decides when the work is done**. A separate evaluator model — picked as the cheapest authenticated model, or via `MYZGOAL_EVALUATOR_MODEL` — reads only what the working model surfaced in the conversation and returns one of three verdicts.

## Install

**As a pi package (recommended):**

```bash
pi install git:github.com/applearound/myzgoal
```

**Local development:** symlink the repo into pi's extension directory:

```bash
ln -s /path/to/myzgoal ~/.pi/agent/extensions/myzgoal
```

Then start `pi` (or run `/reload` in an open session).

## Usage

| Command | Effect |
| --- | --- |
| `/goal <condition>` | Set a goal (≤4000 chars). A turn starts immediately with the condition as the directive. |
| `/goal` | Status: condition, runtime, turns evaluated, evaluator token spend, latest reason. |
| `/goal clear` | Remove the active goal. Aliases: `stop`, `off`, `reset`, `none`, `cancel`. |

One goal per session. Setting a new goal replaces the active one. Resuming a session restores a goal that was still active (condition carried over; turn count, timer and spend baseline reset).

### Writing an effective condition

The evaluator cannot run commands or read files — it judges only what the working model demonstrated in the conversation. Good conditions have:

- **One measurable end state**: a test result, a build exit code, a file count, an empty queue
- **A stated check**: how to prove it — "`npm test` exits 0", "`git status` is clean"
- **Constraints that matter**: e.g. "no other test file is modified"

```text
/goal all tests in test/auth pass (npm test exits 0) and npm run lint is clean; no other test file is modified
```

To bound runtime, include a clause in the condition itself, e.g. "…or stop after 20 turns".

### Guards

- **No-progress guard**: after `MYZGOAL_NO_PROGRESS_LIMIT` (default 3) consecutive turns without tool use, the loop pauses with a warning. The goal stays active; the next user prompt resumes evaluation.
- **Evaluator errors** (transient API failures, timeouts) pause the loop but keep the goal.
- **Hard cap**: set `MYZGOAL_MAX_TURNS` to pause the loop after N evaluations.
- User interrupt (Esc) never triggers an evaluation.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `MYZGOAL_EVALUATOR_MODEL` | cheapest authenticated model | Evaluator model as `provider/model-id` |
| `MYZGOAL_MAX_TURNS` | unlimited | Pause the loop after N evaluator runs |
| `MYZGOAL_NO_PROGRESS_LIMIT` | `3` | Consecutive no-tool-use turns before pausing |

## Development

```bash
npm install            # or symlink deps from a global pi install
npx tsc --noEmit       # typecheck
```

Architecture and design decisions: see [docs/执行计划.md](docs/执行计划.md).

## License

[MIT](LICENSE)
