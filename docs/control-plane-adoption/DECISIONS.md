# Decisions

## 2026-08-25: extend the existing skills substrate

Keep the existing `server/skill-library.ts` and `skills/phone-harness` as the
only skill substrate for this product slice. Use manifests and discovery for
declarations, then apply per-bot grants, capability checks, latest-trigger
selection, and the narrow intersection of declared tools with granted tools.
Skill declarations never grant permission. Keep the deterministic Windows-local
audit path and do not introduce a parallel plugin or skill runtime. OpenBot is a
donor for patterns only and remains out of the product runtime.

## 2026-08-25: accepted per-bot runtime policy

Runtime policy is per bot and has nine controls: wall clock, idle timeout,
cancellation grace, retry cap, maximum tool/agent steps, delegation
concurrency, fresh-session enforcement, handoff byte cap, and cumulative token
policy. Effective defaults are wall `0`, idle `20m`, grace `5s`, retry `1`,
steps `0`, delegation `4`, fresh session `false`, handoff `12000` UTF-8 bytes,
and tokens `disabled` with effective limit `1,000,000`.

Persist only explicit overrides. Missing policy keeps these effective defaults
and exact legacy environment timing; `runtimePolicy: null` resets them. Delete
legacy `turnBudgetMode` without converting it to token policy. Token modes are
Disabled, Soft warning, and Hard cap; Disabled remains the safe default and
does not prematurely stop worker or research tasks. Global room timeout,
deterministic repeat/loop detection, and conflicting-writer guards remain
independent safeguards.

## 2026-08-25: admission snapshot and backend authority

Snapshot the effective runtime policy at turn admission and enforce it on the
server. A live Settings update cannot change the active turn's timers, grace,
limits, retry allowance, delegation fan-out, or handoff ceiling. Settings uses a
local draft with diff-only Save, null Reset, validation-error retention, and a
stable equal-value frame signature; changes apply to the next turn. Backend
guards remain authoritative over any proxy-supplied limits.

## 2026-08-25: selective adoption instead of wholesale migration

Keep OpenMaus as the Windows product and selectively adapt proven Grok Bot control-plane mechanisms.

Reasons:

- OpenMaus already owns the required Windows UI, persistent bots, roster, and provider integrations.
- The donor is pinned to Grok Bot 0.18 and its current build pipeline targets macOS.
- Several reconstructed lifecycle modules are incomplete stubs, while other isolated mechanisms are concrete and useful.
- Replacing the whole application would postpone the current goal and introduce a second platform migration.

This decision may be revisited only after an isolated Windows viability spike demonstrates a lower total migration cost with working equivalents for the OpenMaus-specific roster and provider contracts.

## 2026-08-25: OpenBot is a skills/governance donor, not the new base

Keep OpenMaus as the base application.

Adopt selectively from CopilotKit OpenBot:

- reusable model-neutral skills;
- latest-message skill selection and deterministic tool-offer narrowing;
- separation of skill declarations from capability grants;
- fail-closed action policy and auditable decisions;
- per-bot isolation and AG-UI-style endpoint abstraction where it fits existing providers.

Do not migrate the product wholesale because the inspected OpenBot revision:

- is explicitly alpha;
- requires Docker, PostgreSQL, and CopilotKit Intelligence for its normal stack;
- is oriented around containerized computers rather than the existing Windows-native provider processes;
- does not implement the required bot-to-bot fresh-task delegation, durable receipts, stable routing keys, or Git worktree writer-conflict rules.

The target combination is OpenMaus for the Windows product and provider roster, Grok Bot mechanisms for transcript/lifecycle recovery, and OpenBot mechanisms for skills/tool governance.

## 2026-08-25: accepted Windows CUA identity contract

Windows CUA uses a compatible manifest contract, requiring manifest schema 1,
the observed semver, and an app-lifetime canonical file identity containing
SHA-256 and stable stat data. It does not use a globally hardcoded Windows
driver version. The server accepts only the exact schema-1 supervised Windows
descriptor, revalidates the canonical path and identity before execution, and
legacy Windows descriptors fail closed. Update checks and telemetry remain
disabled for every probe and the runtime descriptor; doctor warnings may leave
the helper degraded-ready without inventing success. Accepted macOS legacy and
Linux supervised behavior are unchanged.

## 2026-08-25: updater signing remains deferred external trust work

Updater isolation and feed integrity guards remain in force. Unsigned Windows
publisher authenticity is deferred because signing requires an external
certificate and credentials; that dependency is not a reason to weaken the
current updater guards, and no such credentials are requested or used.

## 2026-08-25: no implicit Onlook runtime discovery

OpenMaus must not implicitly auto-discover a Bun runtime from Onlook paths.
Explicit operator-provided `PATH` remains allowed, as do the existing explicit
`OMB_EXTRA_PATH`, user `~/.bun/bin`, and CLI-resolution rules. Onlook is donor
and evidence only, not an automatic product runtime dependency.

## 2026-08-25: accepted explicit runtime discovery boundary

Remove automatic donor-runtime discovery from OpenMaus. Inherited `PATH`,
explicit `OMB_EXTRA_PATH`, and user-owned CLI locations remain authoritative;
there is no blacklist or sanitizer and no config migration for the cache/reset
behavior change.

## 2026-08-25: user-managed provider CLIs and Antigravity boundary

User-managed provider CLIs are explicit operator runtimes and are not globally
frozen to one product-wide version. The Antigravity helper keeps its proven
boundary: self-update disabled before diagnostics/provider work, version probe
before credential mutex, direct read-only `agy-pinned.exe`, and no mutable
upstream copy. Special bundled or self-updating helpers use their own isolation
and identity contracts.

## 2026-08-25: pinned Android Platform Tools supply

The packaged Android Platform Tools default is pinned to release `37.0.1` by
per-platform archive filename, byte size, and SHA-256 before extraction. The
extracted `source.properties` revision must match, and a deterministic
`release.json` manifest is emitted.

An explicit local `OMB_ANDROID_PLATFORM_TOOLS_SOURCE` remains allowed as
operator intent, but it must validate the required layout and revision and be
labelled as an override. It does not weaken or masquerade as default archive
pinning and does not inherit the default archive checksum claim.

## 2026-08-25: accepted product stage 6 bounded trust boundary

Product stage 6 is accepted at its declared bounded trust boundary: Windows
CUA identity (6A), explicit runtime discovery with no implicit Onlook Bun
(6B), the existing updater and Antigravity helper boundaries, and pinned
Android Platform Tools supply (6C). This does not globally freeze
user-managed provider CLIs. Windows publisher signing/authenticity remains
deferred external trust work because it requires certificates and credentials;
none are requested or used. Stage 7 begins with a narrow read-only gap audit,
with no implementation allowlist inferred in advance.

## 2026-08-25: Stage 7A isolation and bounded discovery boundary

The first Stage 7 implementation slice is limited to secret-safe, bounded,
per-profile model discovery in the four declared server files. Keep credential
ownership with the consuming scope, prevent cross-profile CLI fallback,
bound streamed responses, options, concurrent fetches, settling time, and
error detail, and preserve opt-in/default/failure-isolation behavior. Stage 7B
unsafe URL metadata, global OpenCode config mutation, and Electron
store/reload rollback remain explicit residuals requiring their own evidence;
they are not part of 7A. Stage 7 is not a new product stage.

## 2026-08-25: accepted Stage 7A boundary

Stage 7A is accepted in the same four-file scope: bounded per-profile
OpenCode CLI fallback, secret-safe custom endpoint probing, streamed body and
catalog limits, concurrent discovery deadlines, stable ordering, and
failure-isolated saved defaults. Existing schema, config, UI, Electron,
environment-reference, and provider architecture remain unchanged, with no
config migration.

Stage 7B was reserved for a narrow read-only evidence audit. Unsafe endpoint URL
metadata, global OpenCode config mutation, Electron store/reload rollback, and
the fixed public-catalog `response.json()` audit question have no
implementation allowlist yet. No 7B write scope is inferred until an exact
gap, invariants, allowlist, and fake/local tests are declared.

## 2026-08-25: completed Stage 7B audit and Stage 7B1 boundary

The read-only Stage 7B audit confirmed the local OpenCode `1.17.17`
configuration precedence: ordinary global/project settings are read first,
`OPENCODE_CONFIG` merges after them, and `OPENCODE_CONFIG_CONTENT` applies
last. Stage 7B1 therefore uses a child-local `OPENCODE_CONFIG_CONTENT` overlay
to remove user-config mutation while preserving unrelated settings and
providers. The exact Stage 7B1 implementation scope reuses the four Stage 7A
server files; no new file or architecture is introduced.

Stage 7B1 also bounds the fixed public catalog path and expands CLI fallback
identity only with non-secret config scope and a digest of config content.
At that earlier boundary, Stage 7B2 strict-new-save/migration-safe URL handling
and Stage 7B3 registry and Electron store/reload rollback evidence had not yet
been accepted. The later Stage 7B2 audit boundary is recorded below; no
ordinary driver-create throw is classified as a reproduced HTTP failure.

## 2026-08-25: accepted Stage 7B1 child-local overlay boundary

Stage 7B1 is accepted in the exact four-file scope above. Custom-endpoint and
local-injection configuration is child-local through deep-merged
`OPENCODE_CONFIG_CONTENT`; user/XDG OpenCode files remain untouched, and
serialized overlays contain only environment references for secrets. CLI
fallback scope includes non-secret config paths/flags and SHA-256 identities of
config/auth content, with the bounded 16-entry/reset behavior preserved. The
fixed public catalog is bounded by actual streamed bytes, options, stable
ordering, and an independent settle/abort deadline; late results cannot poison
fallback. Existing schema/config/UI/Electron/provider architecture is unchanged
and no migration is required.

The focused and five-file matrices, both TypeScript checks, exact diff-check,
static no-user-config-writer audit, and four-file hashes were accepted with
porcelain 121. The worker's fake-ACP observation correction and the lead's
pre-receipt config-content-digest correction were test/regression corrections;
there was no post-receipt production correction at the B1 acceptance boundary.
At that earlier boundary, Stage 7 was not yet accepted: the Stage 7B2
read-only audit was complete and its implementation boundary was recorded
below; the Stage 7B3 audit and allowlist were recorded later.

## 2026-08-25: completed Stage 7B2 URL safety audit and boundary

The Stage 7B2 audit reproduced that the existing endpoint schema and URL
normalization allow userinfo, query, and fragment data to persist and be
publicly echoed, with query/fragment values also breaking `/models` routing.
Strict new-save validation must therefore be paired with legacy preprocessing;
otherwise one old endpoint can discard the whole stored config. The exact
implementation scope is `server/custom-endpoints.ts`,
`server/custom-endpoints.test.ts`, `server/config.ts`, and
`server/config.test.ts`.

The accepted boundary is safe `http(s)` save input, migration of legacy URLs to
scheme/host/port/pathname without converting removed data into credentials,
atomic mode-0600 persistence after full schema success, retry-safe persistence
failure handling, and defense-in-depth safe URL use/output. Existing safe
endpoint behavior and the surrounding config/UI/Electron/provider architecture
remain unchanged. At this earlier B2 audit boundary, Stage 7B3 had no
implementation allowlist; its completed audit and exact boundary are recorded
below.

## 2026-08-25: accepted Stage 7B2 URL safety and migration boundary

Stage 7B2 is accepted in the exact four-file scope: custom endpoint validation
and tests plus `server/config.ts` and `server/config.test.ts`. New saves reject
credentials, query, fragment, and empty URL delimiters while allowing
percent-encoded pathname delimiters. Legacy sanitization removes only unsafe URL
components before strict parsing; atomic mode-0600 migration occurs only after
full validation, is idempotent, and keeps sanitized runtime data available when
persistence fails. Public, probe, and OpenCode consumers apply defense in depth;
the existing UI/Electron/provider architecture is unchanged.

Worker and independent lead evidence matched: focused 58/58, five-file matrix
98/98, both TypeScript checks, and exact diff-check passed. The four post-slice
hashes and porcelain 121 (4 active scope entries plus 117 outside) are recorded
in `CURRENT_STATE.md`. After the implementation receipt, one bounded Node24
strip-types compatibility correction changed only `server/custom-endpoints.ts`
from a parameter property to an explicit readonly field and assignment; B2
behavior was unchanged, and the corrected hash is recorded in
`CURRENT_STATE.md`. At that earlier boundary, Stage 7B3 was the declared
implementation boundary; it is accepted below.

## 2026-08-25: completed Stage 7B3 audit and transaction boundary

The read-only audit accepts registry shadow/all-settled behavior and identifies
the credential environment-before-disk mutation gap, Electron store-first
ambiguity after transport loss, rollback masking, and partial reload/bus/store
state. The exact implementation allowlist is `electron/main.mjs`,
`electron/workspace-credentials.mjs`,
`electron/workspace-credentials.test.mjs`, `server/config.ts`,
`server/config.test.ts`, `server/index.ts`, and `server/index.test.ts`.

The decision boundary is exact transaction snapshots and rollback outcomes,
generic `success`/`rolled_back`/`unknown` taxonomy, bounded idempotent retry
after transport loss, newest-known-state retention for ambiguous outcomes,
shared custom/generic credential handling, and no schema/UI/provider migration.
Driver-create shadows remain normal commits. At this pre-implementation
boundary, Stage 7 was not yet accepted; the later acceptance is recorded below.

## 2026-08-26: accepted Stage 7B3 and bounded roadmap completion

Stage 7B3 is accepted in the exact seven-file scope above. The server uses a
disk-to-environment-to-reload transaction with exact bytes/environment/live
config restoration, exact optional-key replacement, preflight
definite-not-applied `rolled_back`, and generic HTTP outcomes. Electron keeps
store-first semantics, retries only transport loss once, and distinguishes
explicit rollback from newest-state retention for ambiguous outcomes. The
shared custom/generic helper and the Windows sharing-violation regression are
accepted; internal causes never cross the public boundary.

All seven declared product stages are complete at their recorded bounded
acceptance boundaries. This is a roadmap checkpoint, not a new Stage 8. The
only remaining deferred item is unsigned Windows publisher authenticity,
which requires separate user authority for certificates/credentials; it has
no implementation assignment, and no credentials are requested or used.

## 2026-08-27: custom v22 source-integration maintenance boundary

The custom v22 app may check the official developer-release feed, but direct
official binary download and installation remain fail-closed. Upstream source
updates require an isolated `codex/integrate-*` branch from the custom
baseline, exact-commit integration, tests, a staging package, and verified
swap. There is no automatic merge, and the official installer never runs over
the custom build. This is maintenance of the completed seven-stage roadmap,
not a new Stage 8.

## 2026-08-27: accepted custom v23 app-wide Skills and promotion boundary

Accept custom v23 as the current maintenance baseline. Its Skills workflow is
one app-wide extension of `server/skill-library.ts`, not a parallel registry or
an OpenCode migration. The unified Settings catalog covers bundled, recorded,
and globally imported skills; imports use full-batch preflight before writing.
Composer button and `/skills` provide one exact manual selection for the next
accepted direct or room send. Ordinary text never auto-selects a skill.

Hidden per-bot skill and tool grants remain authoritative. Runtime admission
checks all literal-`true` provider capability flags and declared tool grants,
exposes only the selected skill's granted tools, and records stable
prompt-free success or refusal audit metadata. Generic skills remain
provider-neutral. Legacy per-bot data, enable flags, and routes remain
compatible, while retired native discovery links and legacy dispatch prompt
injection remain disabled so they cannot bypass manual admission.

The exact accepted source scope is the 17 paths recorded in
`CURRENT_STATE.md`. Focused, full fake/local, TypeScript, contrast,
whitespace/scope, packaged-server, artifact-marker, and independent visual
browser checks are accepted there with their exact counts and hashes.
Repository-wide lint's 1901 integrated-baseline anti-slop diagnostics are a
pre-existing non-gating residual; focused oxlint for the new standalone Skills
files is green.

The verified staging directory was moved to
`release-codex-local-v23`, both user shortcuts were verified against that final
root, and the old staging and custom v22 release directories were removed.
The accepted runtime has only final-root OpenMausBot/cloudflared processes and
HTTP 200 health on `127.0.0.1:8799`. Historical custom v22 evidence remains
historical and is not rewritten by this decision.

Unsigned Windows publisher authenticity remains deferred external trust work.
It still requires separate authority for a certificate and credentials; none
are requested or used by this acceptance.

## 2026-08-28: safe swarm access and adaptive Runtime Policy slice

Structured handoffs now persist `accessMode: "read-only" | "writer"`; omitted
legacy fields normalize to `writer`. Read-only execution is not provider
enforced, so shared-checkout concurrency remains refused even for two readers.
Concurrent readers require different worktrees. Different isolated worktrees
may overlap logical files, while writer/writer overlap remains refused. The
handoff parser, durable task scope, queue/restart path, conflict guard, and
Chief instructions carry this distinction with deterministic refusal text.

Only a visible section Chief of Staff admitted in the current turn receives
server-authoritative runtime-policy inspection and persistent worker PATCH
tools. The tools are limited to visible workers in the same section, reject
self/Chief/hidden/cross-section targets, validate through the existing policy
validator, require a bounded reason, persist provenance and prompt-free audit,
and apply only at the next admission. The current turn snapshot is immutable.

Each bot has a user-owned persisted `chiefRuntimePolicyLocked` boolean. Missing
legacy data is treated as allowed and is migrated to `false`; the human bot
PATCH/UI may change it, while Chief tools cannot. A locked worker refuses both
persistent Chief policy PATCH and Chief one-task `runtimePolicyOverride`, with
the same exact refusal reason and a persisted refusal audit. The user's lock
or unlock action also writes a prompt-free `lock-change` audit. Ordinary
delegation without an override remains allowed.

`runtimePolicyOverride` is validator-normalized, Chief-only, stored with the
task and pending queue item, survives restart, and merges after bot defaults.
Task admission records effective-policy and override fingerprints without
retaining prompt/tool data. The override fingerprint changes handoff evidence
while the stage key and absolute one-retry cap remain unchanged, allowing one
bounded evidence-changing correction and preventing a retry loop.

Focused fake/local verification for this slice: 9 suites passed, 250 tests
passed, 1 skipped; both server and client TypeScript no-emit checks passed.

### 2026-08-28 correction: effective-policy evidence identity

Handoff `evidenceKey` now includes the secret-free fingerprint of the target's
effective admission policy, computed as persisted bot defaults merged with the
optional task override. `stageKey` and the absolute retry cap are unchanged.
The computed identity is persisted in the pending item and task control, so a
restart preserves an already-issued identity; legacy pending records retain
their stored identity and use a conservative compatibility fallback only when
old evidence metadata is absent.

An exact settled handoff is therefore `duplicate` under the same effective
policy, becomes one allowed corrective attempt after a material persistent
policy change, and is `loop_blocked` after the bounded retry is consumed.
Successful override dispatches add a bounded prompt-free `task-override`
`applied` audit with effective and override fingerprints. Approval, task
creation, or dispatch failure cannot create that applied audit.
