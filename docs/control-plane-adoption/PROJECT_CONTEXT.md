# OpenMaus control-plane adoption

## Objective

Make the Windows OpenMaus application a reliable coordinator for persistent bots while keeping every delegated task fresh, bounded, recoverable, and independent of the bot's currently selected model.

This is a local research and learning project. The user has approved studying the reconstructed Grok Bot 0.18 implementation and adapting useful mechanisms to OpenMaus.

## Canonical paths

- OpenMaus source: `D:\Codex\OpenMausBot-custom`
- OpenMaus runtime/config: `C:\Users\necaj\.openmausbot`
- Grok Bot donor checkout: `C:\Users\necaj\AppData\Local\Temp\grok-bot-0.18-reconstructed-audit`
- Grok Bot donor commit inspected initially: `a9f633e09d49a85829b8236331b9e21f7e612634`
- CopilotKit OpenBot donor checkout: `C:\Users\necaj\AppData\Local\Temp\copilotkit-openbot-audit`
- CopilotKit OpenBot donor commit inspected initially: `d293f2331bd5ff9ba4ad17af6ac94570a157d26d`
- Onlook product source: `E:\Hermes Projects\Onlook`

Do not modify, start, build, reset, clean, or otherwise operate on Onlook while working on this OpenMaus project. Onlook state is evidence only when explicitly needed to understand an OpenMaus incident.

## User-approved architecture decision

Do not replace OpenMaus wholesale with the reconstructed Grok Bot application.

Keep OpenMaus as the Windows shell, UI, bot roster, persistent bot identity layer, provider adapters, and runtime/config owner. Study and adapt Grok Bot control-plane mechanisms in bounded phases:

1. fresh delegation context and compact handoff construction;
2. durable task lifecycle, ownership, queueing, completion receipts, and restart recovery;
3. provider process supervision and model-neutral routing;
4. updater isolation and pinned helper/runtime identities;
5. secrets/provider model discovery only after the lifecycle is stable.

The donor is a behavioral and architectural reference. Validate every adopted mechanism against the actual OpenMaus contracts rather than copying a whole subsystem blindly.

CopilotKit OpenBot is a second selective donor, not the replacement product. Use it for skills, tool narrowing, grants, policy/audit boundaries, secret redaction, endpoint abstraction, and per-bot isolation patterns. Do not import its Docker/PostgreSQL/CopilotKit Intelligence deployment as a prerequisite for OpenMaus.

## Confirmed product requirements

- Existing worker bots are reused. A new bot is not created per task.
- Every delegation creates a fresh task/session for the selected existing bot.
- Parent conversation history, old worker history, large documents, logs, and Obsidian dumps must never be injected into the delegated task.
- Handoff contains only: objective, base/worktree, exact allowed files, forbidden scope, exact changes, verification, and receipt.
- Handoff size is deterministically capped and rejected before dispatch when invalid.
- Worker identity is stable and model-neutral. Provider/model changes must not change routing identity.
- A coordinator may use up to three workers on independent mini-tasks.
- Parallel writers may not touch the same files or the same worktree.
- Architect and Auditor are separate from implementation workers.
- A successful task must produce a terminal receipt. Restart recovery must distinguish running, completed, failed, canceled, and unknown tasks without inventing success.
- Duplicate retries, stale targets, and late completions must be idempotently rejected or reconciled.
- Do not spend expensive models on routine diagnostics when deterministic local evidence is available.

## Known failure families

These are established incidents, not hypotheses to rediscover from scratch:

1. Delegated workers sometimes inherited very large historical context and rapidly consumed quota.
2. `list_bots` could show a bot while `delegate_bot` or `ask_bot` returned `no such bot` because roster identity and execution endpoint identity diverged.
3. A model/provider switch was incorrectly treated as if worker identity had changed.
4. Delegated tasks could finish or be interrupted without a durable receipt, leaving the coordinator in a retry/block loop.
5. Restarts could stop active provider processes and lose the authoritative outcome.
6. Anti-loop and budget guards sometimes blocked legitimate recovery after transport or permission failures.
7. Provider wrappers were vulnerable to self-update and concurrent mutation. Antigravity wrappers were changed to launch a read-only pinned master directly.
8. OpenCode/Hermes/Antigravity failures were sometimes transport, proxy, runtime, or account-isolation defects rather than model defects.
9. Coordinator threads accumulated millions of tokens because they repeatedly inspected and retransmitted old state instead of using durable compact task records.

## Existing local work must be preserved

The OpenMaus worktree is intentionally dirty and contains substantial user-owned changes across Electron, server, provider drivers, UI, and tests. Never reset, clean, overwrite, or discard them. Start by recording `git status --short` and reading the actual implementation.

Relevant existing work includes, but is not limited to:

- `server/delegations.ts` and tests
- `server/handoff.ts` and tests
- `server/store.ts` and tests
- `server/chief-of-staff.ts` and tests
- `server/repeat-detector.ts` and tests
- `server/drivers/*`
- `server/antigravity-accounts.ts`
- `server/antigravity-launcher-regression.test.ts`
- Electron lifecycle and updater changes
- model picker, custom endpoint, and provider UI changes

Do not assume these changes are complete or correct, but do not recreate them from memory.

## Donor mechanisms worth evaluating first

Inspect the implementation and tests behind these donor areas:

- `source/packages/agent-transcript/context-stripping.ts`
- `source/packages/agent-summarization/prepare-messages.ts`
- `source/packages/agent-exec/background-work-registry.ts`
- `source/packages/agent-exec/background-completion-dispatch.ts`
- `source/packages/agent-exec/wakeup/`
- `source/packages/agent-core/goal-continuation.ts`
- `source/shared/observability/request-lineage.ts`
- `source/shared/inference-router.ts`
- `source/shared/node/inference-router-local.ts`
- `source/shared/node/atomic-write.ts`
- `source/packages/agent-store-sync/exclusive-mutation-lock.ts`
- updater guard and publication tests

Some reconstructed modules are empty or tree-shaken stubs. Treat them as unavailable rather than filling gaps by guesswork.

## OpenBot donor mechanisms worth evaluating

Inspect the implementation and tests behind:

- `server/src/plugins/selection.ts`: per-run skill selection from only the latest user message;
- `server/src/plugins/store.ts` and `server/src/db/schema/plugins.ts`: skill definitions, declared tool references, grants, and audit data;
- `server/src/copilot.ts`: construction of the per-run tool offer and AG-UI endpoint boundary;
- `server/src/computer/policy.ts`: fail-closed action policy independent of tool visibility;
- `server/src/computer/supervisor.ts`: per-bot computer/workspace isolation;
- `server/src/channels/thread-identity.ts` and `server/src/channels/thread-status.ts`: durable channel/thread identity patterns.

OpenBot skills are instructions and an accuracy layer, not permissions. A skill may declare tools, but the offered tools must remain the intersection with the bot's existing grants. Selector failure must preserve granted capability and record a reason. Adapt this separation to OpenMaus without importing OpenBot's deployment dependencies.

The inspected OpenBot revision does not contain a production bot-to-bot delegation/task ownership subsystem despite a schema comment mentioning handoff. It also has no Git worktree conflict coordinator. It therefore cannot replace OpenMaus's required delegation lifecycle without substantial new implementation.

## Required deterministic verification

At minimum, maintain or add tests for:

- fresh context for every delegated task;
- handoff size cap and schema;
- absence of parent-history injection;
- reuse of an existing worker bot;
- stable routing key independent of provider/model;
- rejection of conflicting parallel writers/worktrees;
- durable terminal receipt and restart reconciliation;
- idempotent duplicate completion/retry handling;
- provider process exit, timeout, cancellation, and late-result behavior;
- updater/runtime identity pinning where applicable.

## Current external incident

The Onlook Coordinator was not hung. It deliberately entered `BLOCKED` after a receipt-recovery task timed out awaiting permission and its single retry received HTTP 429. This incident is useful evidence for the missing durable task-outcome design, but this OpenMaus project must fix the underlying lifecycle rather than repeatedly messaging that coordinator.

## Definition of done

The control-plane work is complete only when a local Windows test proves:

1. the same persistent worker can receive multiple sequential fresh tasks;
2. each task starts without prior chat history;
3. concurrent non-conflicting tasks work, conflicting writes are rejected before launch;
4. provider/model switching does not break bot routing;
5. app/server restart produces a deterministic recovered status and receipt;
6. stale or duplicate events do not create loops;
7. existing relevant test suites pass and a concise implementation receipt is recorded.
