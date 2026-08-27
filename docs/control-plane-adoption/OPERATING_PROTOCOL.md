# Codex operating protocol

## Ownership

One lead Codex task owns the OpenMaus control-plane adoption. It may use subagents for read-only research and independent mini-tasks, but it remains the sole integration authority.

## Before changing code

1. Read `PROJECT_CONTEXT.md` completely.
2. Record current `git status --short`.
3. Inspect the actual local implementation and tests.
4. Compare only the relevant donor modules.
5. Write a short mapping: incident -> current owner -> donor mechanism -> proposed bounded change -> deterministic test.

Do not repeat broad historical diagnosis already recorded in `PROJECT_CONTEXT.md`.

## Work allocation

- At most one writer per file set and worktree.
- Read-only analysis may run in parallel.
- Implementation slices must declare exact files before editing.
- A slice ends with tests and a compact receipt, not a narrative status loop.
- Do not create another chief coordinator.

## Recovery behavior

- Never infer task failure solely from a missing UI message.
- Check persisted task state, process identity, event stream, and terminal receipt.
- A transport timeout is `UNKNOWN` until reconciled, not automatically `FAILED`.
- Retry only if the operation is idempotent and the original task cannot still mutate state.
- One failure fingerprint gets one bounded corrective attempt. Escalate with exact evidence after that.

## Communication

Progress updates should state only:

- what is now proven;
- what changed;
- what verification passed or failed;
- the next bounded action.

Avoid retransmitting logs, parent history, large documents, or repeated explanations.

## First milestone

Produce and implement the smallest coherent lifecycle foundation that covers:

- stable worker routing identity;
- fresh task/session creation;
- bounded handoff validation;
- persisted task state and terminal receipt;
- restart reconciliation;
- conflict-key admission control.

Provider-specific improvements come after this milestone unless they are required to test it.
