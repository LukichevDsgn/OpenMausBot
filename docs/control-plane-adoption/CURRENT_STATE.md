# Current control-plane state

Updated: 2026-08-27

This is the canonical continuation point for new Codex tasks. Read it with
`PROJECT_CONTEXT.md`, `OPERATING_PROTOCOL.md`, and `DECISIONS.md`. Do not
reconstruct state from prior chat history or old logs.

## Accepted lifecycle foundation

Provider supervision and the durable task receipt are accepted. The accepted
slice covers launch failure, provider exit, timeout, explicit cancellation,
application restart, and late or duplicate completion reconciliation. Terminal
receipts are persisted exactly once; a late or duplicate event cannot rewrite a
terminal state. `UNKNOWN` is used when the provider outcome is not proven.
Task lifecycle, busy/activity state, and process supervision settle together,
with no orphan task or process left by the covered transitions.

## Accepted skills substrate

The accepted skills slice extends the existing `server/skill-library.ts` and
`skills/phone-harness` substrate. It covers validated manifests and discovery,
per-bot skill and skill-tool grants, latest-trigger selection, narrow
skill-tool intersection, capability checks, and a deterministic Windows-local
audit log and test surface. Skill declarations never grant permission by
themselves. There is no parallel skill system. OpenBot remains a donor for
patterns only, not a migration target.

## Accepted runtime controls

Runtime 2A and 2B are accepted. The per-bot runtime policy has nine controls:

- `wallClockTimeoutMinutes`
- `idleTimeoutMinutes`
- `cancellationGraceSeconds`
- `retryCap`
- `maxToolAgentSteps`
- `delegationConcurrency`
- `freshSessionEnforcement`
- `handoffByteCap`
- `cumulativeTokenPolicy` with `mode` and `limit`

Effective defaults are wall clock `0` (off), idle `20` minutes, cancellation
grace `5` seconds, retry cap `1`, tool/agent steps `0` (off), delegation
concurrency `4`, fresh session `false`, handoff cap `12000` UTF-8 bytes, and
tokens `disabled` with effective limit `1,000,000`.

Only explicit overrides are persisted. Missing policy preserves the effective
defaults and exact legacy environment timing; `runtimePolicy: null` resets to
defaults. Legacy `turnBudgetMode` is deleted and never mapped to token policy.
Non-unit-aligned legacy idle and cancellation values remain exact at turn
admission.

Each admitted turn receives an immutable policy snapshot. Enforcement is
server-owned, including retry, delegation, handoff, wall/idle/step/token
limits, and cleanup. Settings uses a local draft, diff-only Save, null Reset,
and retains the draft on validation failure. Changes apply only to the next
admitted turn. Equal-value server frames use a stable policy signature, and all
runtime-policy inputs are disabled while Save or Reset is in flight.

## Guards that remain active

The global room `turnTimeoutMinutes` remains in force. Deterministic
repeat/loop detection and conflicting-writer guards remain active independently
of runtime policy. Token policy modes are Disabled, Soft warning, and Hard cap;
Disabled is the default and must not prematurely stop worker or research tasks.

## Accepted Phase 6A: Windows CUA helper identity

Phase 6A is accepted. Windows CUA candidate priority remains explicit
`CUA_DRIVER_PATH`, packaged resource, then the official per-user install. The
Windows driver version is not hardcoded: readiness requires manifest schema 1,
records the observed semver, and pins the app-lifetime canonical regular-file
identity with SHA-256 and stable stat data.

Update checks and telemetry are `false` for every probe and the published
runtime descriptor. The identity is captured before and after probes; manifest,
observed-version, canonical-path, or identity mismatch, mutation, invalid
spawn, or invalid descriptor fails closed. The server accepts Windows only
through the exact `schemaVersion: 1` supervised descriptor, rejects legacy
Windows descriptors, and revalidates the canonical file identity immediately
before exposing the executable command. A doctor failure remains
degraded-ready only; it is not converted into invented success. Accepted macOS
legacy behavior and the Linux supervised descriptor/runtime contract remain
unchanged.

## Accepted Phase 6B: explicit runtime discovery only

Phase 6B is accepted. Automatic discovery of
`%LOCALAPPDATA%\Programs\@onlookstudio\resources\bun` has been removed.
Inherited `PATH`, explicit `OMB_EXTRA_PATH`, and the user's `~/.bun/bin`
remain allowed; there is no blacklist or PATH sanitizer. A restart or
`resetPathCache` removes the former implicit discovery, and no config
migration is needed.

Worker and lead evidence for `server/env-path.test.ts` is 14 passed and 8
expected POSIX skips on Windows. Both TypeScript checks, diff integrity, and
the two-file scope check are green; the default porcelain count remains 118.

## Existing Antigravity provider boundary evidence

The local Antigravity wrapper version probe reports `1.1.19` for both A/B
paths. The explicit local launcher regression is 6/6. Self-update is disabled
before diagnostics and provider work; the version probe precedes the
credential mutex; the read-only direct `agy-pinned.exe` path is used, with no
mutable upstream copy.

User-managed provider CLIs remain explicit operator runtimes. OpenMaus does
not globally hardcode every provider version; special self-updating or bundled
helpers use their own proven isolation and identity boundaries.

## Accepted Phase 6C: Android Platform Tools supply

Phase 6C is accepted. Its exact three-file scope is:

- `scripts/prepare-android-tools.mjs`;
- `scripts/android-platform-tools-release.mjs`;
- `scripts/android-platform-tools-release.test.mjs`.

The packaged default is pinned to release `37.0.1` with versioned
per-platform URLs. Exact archive byte size and SHA-256 are verified before any
archive write or extraction. Staged layout, archive-entry containment,
revision, and platform-specific `adb`/`fastboot` regular non-symlink checks
complete before replacement.

The current staged `source.properties` and `adb` report revision
`37.0.1`. Official Google repository metadata reports `37.0.1`; the lead
verified the official SHA-1 and size and independently fetched the bytes in
memory to derive these SHA-256 values:

- `linux`: `platform-tools_r37.0.1-linux.zip`, size `9054187`, SHA-256
  `d230f13842f60f782a8645f9c813f8f845bf36089ea7289f28c48f17979313f1`;
- `darwin`: `platform-tools_r37.0.1-darwin.zip`, size `16110554`, SHA-256
  `ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d`;
- `win32`: `platform-tools_r37.0.1-win.zip`, size `8044989`, SHA-256
  `45f4d63113e895ebde0c90f194099a4676b6ac653bd28d54314a9e022bbc1a99`.

`release.json` is deterministic and schema version 1. The explicit
`OMB_ANDROID_PLATFORM_TOOLS_SOURCE` remains a validated operator override
with exact layout and revision, labelled `operator-override` and without a
default archive checksum claim. Complete validation precedes replacement;
failed validation preserves the existing final output. No config migration is
needed. The next packaging regeneration adds `release.json` and replaces
the mutable latest behavior with the pinned default.

## Product stage 6 bounded trust boundary

Product stage 6 is complete at the declared bounded trust boundary:

- accepted 6A Windows CUA identity;
- accepted 6B explicit runtime discovery with no implicit Onlook Bun;
- existing updater integrity/isolation and Antigravity helper boundaries
  remain proven;
- accepted 6C Android Platform Tools supply.

This completion does not claim broader publisher trust. Stage 7 is recorded
below at its own declared bounded trust boundary.

## Stage 7 accepted completion and audit record

The Phase 6 checkpoint is accepted. Stage 7 is complete at its declared
bounded trust boundary. The existing
secret and model-discovery substrate is proven and must not be recreated:

- Electron workspace credentials migrate plaintext API-key fields, including
  dynamic `customEndpointKeys`, into safeStorage-backed `credentials.bin`
  for packaged Windows and inject one scoped environment name per secret.
- Server config exposes configured booleans/metadata, narrows credentials to
  their consuming driver, strips workspace credentials from unrelated child
  environments, and custom-endpoint OpenCode config carries an environment
  reference rather than a raw key.
- Custom endpoint `/models` discovery is opt-in and keeps the saved default
  when a provider is unavailable.
- Opening ModelPicker is read-only with respect to Antigravity OAuth/quota;
  there is no implicit usage or OAuth call.

The focused read-only baseline passed 5 files, 66/66:

- `electron/workspace-credentials.test.mjs`;
- `server/custom-endpoints.test.ts`;
- `server/config.test.ts`;
- `server/drivers/acp/opencode-go.test.ts`;
- `src/lib/custom-models.test.ts`.

No real credentials, OAuth, quota, or external network was used.

### Reproduced local-fake gaps

1. `server/custom-endpoints.ts` accepts a `baseUrl` containing userinfo,
   query tokens, or fragments and `publicCustomEndpoint` returns it
   unchanged.
2. `testCustomEndpoint` returns an upstream error body verbatim; a fake 401
   reflected the exact supplied API key.
3. A fake `/models` response with 5000 IDs produced 5001 picker options;
   body size, model count, and fetch fan-out are unbounded.
4. `server/drivers/acp/opencode-go.ts` has one module-global
   `lastSuccessfulCliCatalog`. After profile A succeeded and distinct
   profile B failed, B received A's model list.
5. `ensureOpenCodeCustomEndpointModel` mutates the user's global
   `~/.config/opencode/opencode.json` provider row. A local temp proof showed
   an existing provider `baseURL`/apiKey reference replaced by OpenMaus
   endpoint values. This is a separate ownership/isolation question requiring
   primary OpenCode config-path evidence before a write slice.

### Narrow donor mapping

Only OpenBot `server/src/copilot.ts` endpoint/secret boundary was inspected.
Its owning closure resolves model credentials while the endpoint runtime does
not hold configuration secrets; adopt that ownership principle only. Its
scheme-only `isHttpUrl` check does not solve the reproduced URL-metadata gap
and is not copied. No donor stack or deployment migration is in scope.

### Stage 7A implementation scope and pre-slice audit

Stage 7A is the narrow secret-safe, bounded, per-profile model-discovery
slice. Its exact implementation allowlist is only:

- `server/custom-endpoints.ts`;
- `server/custom-endpoints.test.ts`;
- `server/drivers/acp/opencode-go.ts`;
- `server/drivers/acp/opencode-go.test.ts`.

Pre-slice SHA-256:

- `server/custom-endpoints.ts`: `7240DFEB9DCA439ECD4549490C43FF7F62A589BE9E37E62EECD0424CE6863CFE`;
- `server/custom-endpoints.test.ts`: `B2D93BA6C1543870FDFEBC3A756AD5D6834A3F4C13E34159C68137E5AE80D666`;
- `server/drivers/acp/opencode-go.ts`: `65FC207F68468D9A82D968EFE37818D873536895893B7A7FBE6D60EDEEE6433B`;
- `server/drivers/acp/opencode-go.test.ts`: `A4340F37E38907DFBD8747F13C6BBC2AE4AEEFE92D924456A0BD5F22F3A451B4`.

Stage 7A DoD and invariants:

- Replace the global CLI fallback with a bounded per-profile/per-config scope
  cache. Different CLI, home, XDG/app-data, desktop-state, or auth-content
  scopes cannot share fallback. Never retain or log raw
  `OPENCODE_AUTH_CONTENT`; if it participates in identity, use only a
  digest. The same scope may retain its last success. The cache has a
  deterministic maximum of 16 entries and deterministic eviction.
- Custom endpoint response parsing enforces actual streamed bytes, not only
  `Content-Length`, with a maximum of 8 MiB.
- Keep at most 2048 options per endpoint including its saved default, at most
  4096 custom-endpoint options total, stable endpoint/model order, and
  deterministic de-duplication.
- Allow at most 8 live discovery endpoint fetches per refresh as one bounded
  concurrent batch with an independent 5-second settling deadline. The
  deadline also rejects an injected fetcher that ignores `AbortSignal`.
  Saved defaults remain deterministically available when discovery is skipped
  or fails, subject to the total cap.
- Non-2xx probes preserve numeric status but never return upstream body/message,
  API key, Authorization header, or unsafe URL detail. Timeout and network
  failures return bounded generic messages.
- Drop discovered model IDs containing the exact endpoint key so a
  malicious/reflection endpoint cannot turn the key into picker text.
- Retain opt-in discovery, `useForNewChats`/default ordering, default
  fallback, endpoint failure isolation, and the current OpenMaus/OpenCode
  architecture.
- Make no config, UI, or Electron migration in 7A; existing valid endpoint
  metadata and picker behavior remain unchanged.
- Use only fake fetch/streams, fake timers, and local temporary state in tests.
  No network, OAuth, credentials, provider quota, or real user files.
- Required verification is the focused two-suite run, the existing five-file
  66-test matrix, server/full TypeScript, diff-check, and exact four-file
  scope/hash audit.

The baseline porcelain is 121 and remains 121: all four 7A paths are already
dirty or untracked, and 117 entries outside the four-file 7A scope remain
unchanged.

### Accepted Stage 7A: secret-safe bounded per-profile discovery

Stage 7A is accepted with the exact four-file scope above. The OpenCode CLI
last-success fallback is scoped by the exact CLI and the required
profile/config/state fields. `OPENCODE_AUTH_CONTENT` participates only through
its SHA-256 identity. The cache retains same-scope fallback, never shares a
fallback across scopes, evicts deterministically at 16 entries, and is fully
cleared by reset.

Custom endpoint discovery enforces an actual streamed body limit of 8 MiB,
2048 options per endpoint including its saved default, 4096 total options, and
at most 8 concurrent live discoveries. Each discovery has an independent
5-second settle and abort boundary. Results merge in stable endpoint order;
saved defaults remain available when discovery is skipped or fails, the first
present `useForNewChats` default remains selected, and endpoint failures are
isolated.

HTTP probes preserve numeric status without returning upstream body, raw
errors, keys, Authorization values, or unsafe URL details. Timeout, network,
parse, and body-limit failures are generic. Discovered model IDs containing
the exact endpoint key are dropped. Existing schema/config/UI/Electron,
environment-reference, and OpenMaus/OpenCode provider architecture remain
unchanged. No config migration is required; existing valid endpoints and
saved defaults remain usable, while discovery is now bounded and
failure-safe. Stage 7B behavior is unchanged.

Acceptance evidence from both worker and independent lead:

- focused two-suite run: 2 suites, 29/29 passed, 0 skipped;
- five-file matrix: 5 suites, 76/76 passed, 0 skipped;
- server and full TypeScript checks and exact `git diff --check`: passed;
- post-slice hashes:
  `server/custom-endpoints.ts`:
  `196A8FC3040FEC4DA018AE3EE9E41676F4FFA9D33D44E4039AB6F97D2FD2925A`;
  `server/custom-endpoints.test.ts`:
  `5B43C3D09FD16B03703E6E1523603393024BF70C7F7501E169CA5CC48E855518`;
  `server/drivers/acp/opencode-go.ts`:
  `73D8E1E2DB857C888E9DE6FEB9C5E5A61A3CC0F6EC55C392E46461A312FD353C`;
  `server/drivers/acp/opencode-go.test.ts`:
  `7C3B03B8EA45BB77E8AC19D7E4C6942BFEDF0185E932FD8D636F9B15FDDF9327`;
- default porcelain remains 121: four accepted Stage 7A entries and 117
  preserved outside entries.

Independent black-box runtime-equivalent evidence kept profile B fallback
`null`; an injected never-settling fetch returned only the saved default after
5003 ms. The first one-shot Node harness exited early because the production
deadline timer is intentionally unref'd and no server handle existed. One
bounded harness correction added a ref'd keepalive matching the real server
lifetime; it passed and caused no product code correction. The worker made one
fixture-only correction: an eviction test initially populated exactly 16
scopes instead of 17; the boundary fixture was corrected and the final suite
was green. No network, real credentials, OAuth, quota, real provider or user
config, build, or runtime mutation was used.

### Completed Stage 7B read-only audit

The Stage 7B read-only audit is complete. Primary local evidence, without
network access, is the installed OpenCode `1.17.17` binary at
`C:\Users\necaj\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`,
SHA-256
`9897A7B5EA4960C68F5CEA7E8AC83DA5DC6D100468B844B05925FC387A7A7F8E`.
Primary embedded code confirms `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, and
`OPENCODE_CONFIG_CONTENT`; ordinary global configs are read first,
`OPENCODE_CONFIG` is merged after them, and `OPENCODE_CONFIG_CONTENT` is
applied last. A per-child `OPENCODE_CONFIG_CONTENT` overlay therefore removes
the need to write user config while preserving ordinary global/project reads.

The exact Stage 7B1 gaps and invariants are:

1. Both custom-endpoint and `ensureOpenCodeInjectModel` writer paths currently
   mutate the user/XDG `~/.config/opencode/opencode.json`; local inject may
   also write `hostApiKey`. After 7B1, no user/XDG OpenCode file is created or
   changed. Provider/model overlays are child-local environment data. Custom
   keys and local/env/file-backed keys are represented only through env
   references; raw secrets are never serialized.
2. An existing valid `OPENCODE_CONFIG_CONTENT` merge must preserve unrelated
   keys and providers. Malformed or non-object content fails closed with a
   generic error and no echo. Concurrent children receive independent
   overlays.
3. CLI fallback scope must include `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`,
   the relevant disable flags, and only the SHA-256 identity of
   `OPENCODE_CONFIG_CONTENT`; raw content is never cached or logged.
4. The fixed trusted public catalog is a real boundedness gap: it uses direct
   `response.json()`, abort-only timeout, and unlimited options. It needs
   actual streamed 8 MiB parsing, at most 2048 options including static
   defaults, stable de-duplication/order, and an independent 8-second
   settle-and-abort deadline even when an injected fetcher ignores
   `AbortSignal`, while retaining existing last-success/static fallback.
5. Do not change schema, config, UI, Electron, or provider architecture. Do
   not migrate or clean the old user config; it remains byte-identical and the
   child overlay has precedence. Tests use only fake streams/timers and temp
   homes, with no network, credentials, OAuth, quota, or user files.

### Accepted Stage 7B1: child-local overlays and bounded public catalog

Stage 7B1 is accepted in exactly the following four-file scope:

- `server/custom-endpoints.ts`;
- `server/custom-endpoints.test.ts`;
- `server/drivers/acp/opencode-go.ts`;
- `server/drivers/acp/opencode-go.test.ts`.

Both custom-endpoint and local-injection paths now use only a per-child
`OPENCODE_CONFIG_CONTENT` deep merge. Valid unrelated config keys and providers
are preserved; malformed, `null`, or array content fails closed with a generic
error; concurrent child environments receive independent overlays. No
production writer reads, creates, or changes a user/XDG `opencode.json`; the
legacy user file remains byte-identical and no migration occurs. Custom, local,
file-backed, and env-backed secrets remain in the child environment, while the
serialized overlay contains only environment references.

CLI fallback identity includes the config paths and disable flags, plus only
SHA-256 identities for `OPENCODE_CONFIG_CONTENT` and
`OPENCODE_AUTH_CONTENT`. The bounded 16-entry/reset semantics remain intact.
The fixed public catalog now enforces an actual streamed 8 MiB limit, at most
2048 total options including static defaults, stable ordering and de-duplication,
an independent 8-second settle-and-abort boundary, and a late-result guard that
cannot change the last-success fallback. Existing fallback behavior remains.
Schema, config, UI, Electron, and provider architecture are unchanged.

Acceptance evidence from the worker and independent lead:

- focused two-suite run: 36/36 passed for each run, 0 skipped;
- five-file matrix: 5 suites, 83/83 passed for each run, 0 skipped;
- server and full TypeScript checks passed for each run;
- exact `git diff --check` passed;
- lead static audit: `NO_USER_CONFIG_WRITER_REFERENCES`;
- post-slice hashes:
  `server/custom-endpoints.ts`:
  `7B5579E3CC4DDBB3EF95AFB8870D5532210DE714A2D820F5D3C4AFEBD36168ED`;
  `server/custom-endpoints.test.ts`:
  `80BD947799D378003D463ADCA1CF8876ECBDC4B1C9AD9668E13442F0E26C3D66`;
  `server/drivers/acp/opencode-go.ts`:
  `C536F63E530D065878136651C19583EDD3A860358B09725D3CCCAFCBE53BB800`;
  `server/drivers/acp/opencode-go.test.ts`:
  `BBAAE5B6AA67AF2458EFC6E18284BBA19D306534455B94A8C913F53E54CD63BE`;
- default porcelain remains 121: four accepted Stage 7B1 entries and 117
  preserved outside entries.

The worker made one test-observation correction because the allowlist fake ACP
dump intentionally does not expose `OPENCODE_CONFIG_CONTENT`; the direct
overlay and no-user-file regressions remained. Before the final receipt, the
lead spot-check found that the scope key lacked a separate config-content
digest; that digest and its same-home/different-content fallback regression
were added before acceptance. No post-receipt production correction occurred.
No network, real user config, credentials, OAuth, quota, or build was used.

### Completed Stage 7B2 read-only audit and implementation boundary

The Stage 7B2 read-only audit reproduced the unsafe URL boundary using local
source and fake inputs. `customEndpointSchema` currently checks only URL plus
`http(s)`, `normalizeBaseUrl` only removes a trailing slash,
`publicCustomEndpoint` returns `baseUrl`, and `endpointModelsUrl` concatenates
`/models`. Consequently, a valid URL containing userinfo, query, or fragment
is stored and publicly echoed; query/fragment content also breaks `/models`
routing. Applying a strict schema without legacy preprocessing is unsafe because
one old endpoint would make `parseStoredConfig`/`loadConfig` reject the entire
config.

The exact Stage 7B2 implementation allowlist is:

- `server/custom-endpoints.ts`;
- `server/custom-endpoints.test.ts`;
- `server/config.ts`;
- `server/config.test.ts`.

Stage 7B2 invariants and DoD:

1. New save/test input accepts only an `http(s)` base URL without
   username/password, query, or fragment, including empty `?`/`#` delimiters.
   Percent-encoded `?`/`#` inside the pathname remain valid. Generic errors do
   not reflect the URL or secret. Existing safe URLs retain current trimming and
   trailing-slash normalization.
2. Legacy stored valid `http(s)` URLs are migrated to scheme plus host, port,
   and pathname; userinfo, query, fragment, and empty delimiters are removed.
   Removed material never becomes an API key or credential. All other endpoint
   fields and unrelated top-level config are preserved.
3. `parseStoredConfig` returns sanitized runtime data instead of dropping the
   whole config for this legacy URL. After full schema success, `loadConfig`
   atomically rewrites the original raw config with sanitized URLs using mode
   `0600`; the rewrite is idempotent. Persistence failure does not return unsafe
   runtime data or echo unsafe input and does not clear already sanitized
   runtime data; the next load retries migration.
4. `publicCustomEndpoint`, `endpointModelsUrl`, and the OpenCode overlay apply
   the safe-base-URL rule defensively even when a raw legacy object bypasses the
   parser. Public, API, and error output contain no userinfo, query, or fragment
   tokens.
5. Existing safe endpoints, defaults, keys, config, UI, Electron, and provider
   architecture remain unchanged. Packaged Electron needs no separate migration:
   server load performs the atomic migration after the Electron credential
   sweep. Tests use no network, user config, real credentials, OAuth, quota, or
   build.

The pre-slice hashes are:

- `server/custom-endpoints.ts`:
  `7B5579E3CC4DDBB3EF95AFB8870D5532210DE714A2D820F5D3C4AFEBD36168ED`;
- `server/custom-endpoints.test.ts`:
  `80BD947799D378003D463ADCA1CF8876ECBDC4B1C9AD9668E13442F0E26C3D66`;
- `server/config.ts`:
  `6DFA0F88C9661A6AEB9AFB02AD8C00E93B5E943BB70285CCB62DBB6F30FE90DA`;
- `server/config.test.ts`:
  `CA3F3C5EFA3852707351F923FF46C423BD7E5FF37FCBE39C1CC5FD243025C8F2`.

The baseline focused run is 2 suites, 43/43 passed. Default porcelain remains
121: the four Stage 7B2 scope entries and 117 preserved outside entries.

### Completed Stage 7B3 read-only audit and implementation boundary

The Stage 7B3 read-only audit confirmed that `registry.load` catches
`driver.create` failures and creates shadows, while `disposeAll` uses
`allSettled`; an ordinary driver-create error is therefore not an HTTP
failure. It reproduced these source gaps:

- custom PUT/DELETE calls `syncCustomEndpointKey` before disk save/remove, so
  a disk error can leave process environment state changed;
- Electron applies store-first and then fetches the server; the broad catch
  currently rolls back the store after a lost response even though the server
  may have committed, while rollback-save failure can mask the original error;
- an unexpected reload/bus/store throw can still leave disk, environment,
  runtime config, or fleet state partial.

The exact Stage 7B3 implementation allowlist is:

- `electron/main.mjs`;
- `electron/workspace-credentials.mjs`;
- `electron/workspace-credentials.test.mjs`;
- `server/config.ts`;
- `server/config.test.ts`;
- `server/index.ts`;
- `server/index.test.ts`.

The B3 pre-slice SHA-256 values are:

- `electron/main.mjs`:
  `669627DD783006AC3C72072ED23BC10E5566849A74AE2E1231BA717969DE61B1`;
- `electron/workspace-credentials.mjs`:
  `96A7C614D4C9BC6A042A307DEAA8B162685DFD3169C926509DE78DEF44556A04`;
- `electron/workspace-credentials.test.mjs`:
  `D58390EF6B0720B24DC256FF04A8D466C4C3F3D58A359A758046877F80FD7327`;
- `server/config.ts`:
  `33A6B918E1AF87F9C4141F93EFEA594E644D04B79EDD6C0057A503A94B582C88`;
- `server/config.test.ts`:
  `AA2494E953F6DD6F7766F19D57985220496DC124343293C835404AFFEDE26C62`;
- `server/index.ts`:
  `7A0A6105DEE50DDF9ABABB737834274FC0D3148096A9E087D3A795C538D430EC`;
- `server/index.test.ts`:
  `5C66A1ED272202BF1B15197DE8C80550BF87ABDD05440A24BE4A24C2C5C120AA`.

Stage 7B3 invariants and DoD:

1. The server transaction captures exact config-file existence/bytes, live cfg,
   and relevant credential environment. Disk mutation precedes env mutation.
   Any apply/reload throw restores disk, env, and cfg; if reload began, the old
   fleet is rebuilt. Existing active-turn UNKNOWN lifecycle behavior remains.
2. A pure transaction outcome is `success`, `rolled_back` only when
   restoration succeeds, or `unknown` when rollback/reload restoration fails.
   Original and rollback causes remain internal; HTTP exposes only generic
   error plus outcome, never secrets, paths, or causes. Driver-create shadows
   remain normal commit behavior.
3. Electron safeStorage remains store-first. Server mutation is idempotently
   retried at most once only after transport loss. Explicit 4xx/not-applied or
   `rolled_back` restores prior encrypted and in-memory state. Transport loss
   after bounded retry, ambiguous 5xx, or unknown outcome retains newest
   encrypted/in-memory state and reports generic UNKNOWN/retry. Rollback-store
   failure retains the newest known-written state and both internal causes.
4. Custom save/delete and generic credential handlers use the same helper.
   Unknown custom save may leave an encrypted key without metadata; unknown
   delete may leave metadata unconfigured; neither fabricates metadata.
   Retrying the same operation/id is deterministic reconciliation. Success and
   existing dev-mode behavior remain unchanged.
5. No credentials.bin/config schema migration, UI/provider architecture
   change, network, real credentials, user config, or build is in scope.

The baseline after the B2 compatibility correction was focused 3 suites,
120 passed and 1 existing skip. The final B3 evidence is recorded below;
product stages remain seven and are now complete at their declared bounded
acceptance boundaries.

### Accepted Stage 7B3: exact transaction and credential reconciliation

Stage 7B3 is accepted in the exact seven-file scope above. The server
transaction applies disk, then environment, then live config/fleet reload;
it restores exact config-file bytes, relevant environment, and live config,
rebuilding the old fleet when reload began. Exact optional-key replacement
prevents stale live configuration. A preflight read/clone failure is definite
not-applied and returns `rolled_back` without invoking mutation callbacks.
Outcomes are `success`, `rolled_back`, or `unknown`; original and rollback
causes remain internal, while HTTP exposes only a generic error and outcome.
Driver-create shadows remain normal commits.

Electron remains store-first, retries the same operation at most once only
after transport loss, rolls back on explicit rejection or `rolled_back`, and
retains newest encrypted/in-memory state for ambiguous or `unknown` outcomes.
The generic credential and custom-endpoint paths share this helper. The
Windows regression uses a real external `config.json` sharing violation,
then proves metadata-only save reports `configured:false` after the lock is
released.

Final independent lead evidence:

- focused Electron/config/index: 3 suites, 134 passed and 1 existing skip;
- canonical five-file matrix: 111/111;
- client and server TypeScript `--noEmit`: green;
- Node checks for Electron main/workspace and TypeScript config/index: green;
- exact seven-file `git diff --check`: green;
- porcelain remains 121: 7 accepted scope entries and 114 preserved outside.

Post-acceptance hashes:

- `electron/main.mjs`:
  `778158029A13F5E0D99FA193D91B6FE28457BFE96447B4CD286002296B5B97F9`;
- `electron/workspace-credentials.mjs`:
  `DF374FC2283FB99162820AD90795173A8FD575A4C8AAC012D980AF85E589EB6D`;
- `electron/workspace-credentials.test.mjs`:
  `5A820A4A9BB969D088FE7CAFE11B0D05B1A0AA1D9DA55AE83849F29B3080B2A6`;
- `server/config.ts`:
  `D7EA3CDC0AEB7823FED8795881613F00E8DF528CCC896DDBCE08479F6A3791A3`;
- `server/config.test.ts`:
  `0E26006F046EBD2810B08D89F2AAEE3FB0B5C409D1FEB7523C9FCBC4C861EC00`;
- `server/index.ts`:
  `845C426799C9A7137B2D0BC0A068F56B9DED5C145BD1AC0854A62D25C23487FD`;
- `server/index.test.ts`:
  `B2202F329A0C409516CE324A2D06900EB2DE47B337992C4DFFE4CF1FEE17E056`.

Correction trail is bounded and closed: one test callback typing correction;
the rejected `rmSync(DATA_DIR)` fixture after repeated Windows `EPERM` was
replaced in a new test-only slice by the `config.json` `FileShare` lock;
the lead-found exact live-config stale-key correction; and the lead-found
preflight path-leak correction. No network, user config, real credentials,
OAuth, quota, or build was used.

### Accepted Stage 7B2: safe endpoint URLs and legacy migration

Stage 7B2 is accepted in the exact four-file scope above:

- `server/custom-endpoints.ts`;
- `server/custom-endpoints.test.ts`;
- `server/config.ts`;
- `server/config.test.ts`.

New endpoint URLs are strict `http(s)` values without credentials, query,
fragment, or empty `?`/`#` delimiters; percent-encoded delimiters in the
pathname remain allowed. Validation errors are generic and do not echo input.
The pure legacy sanitizer removes only unsafe URL components, never converts
them into credentials, and preserves endpoint metadata and unrelated raw config.
`parseStoredConfig` sanitizes before strict schema validation. `loadConfig`
persists only after full validation through atomic mode-0600 storage, is
byte-idempotent on repeated loads, and keeps sanitized runtime data usable when
persistence fails so a later load retries. Public endpoint output, probes, and
OpenCode overlays apply the same safe-base-URL defense in depth. UI, Electron,
and provider architecture are unchanged.

Worker and independent lead evidence is identical:

- focused: 2 suites, 58/58 passed;
- five-file matrix: 5 suites, 98/98 passed;
- server and full TypeScript checks passed;
- exact `git diff --check` passed;
- tests used temp directories only; no network, user config, credentials,
  OAuth, quota, or build was used;
- after accepted Stage 7B2, one bounded post-receipt production compatibility
  correction replaced the Node24 `--experimental-strip-types`-incompatible
  `ProbeFailure` parameter property with an explicit readonly field and
  assignment; Stage 7B2 behavior was unchanged;
- post-slice hashes:
  `server/custom-endpoints.ts`:
  `F3B7E91F472C37502C2ADFC32735C94483971CCA36B34311FED1FBAD6246EB2C`;
  `server/custom-endpoints.test.ts`:
  `852D236398E5149C7C3FA2FDA9E675ED7E95BE9FDF585169E2E567EF653E5F4A`;
  `server/config.ts`:
  `33A6B918E1AF87F9C4141F93EFEA594E644D04B79EDD6C0057A503A94B582C88`;
  `server/config.test.ts`:
  `AA2494E953F6DD6F7766F19D57985220496DC124343293C835404AFFEDE26C62`;
- corrected `server/custom-endpoints.ts` hash:
  `A4551D2229E8738C94B143D642653EE6EB70F84395364436184E7906F5A52C89`;
- post-correction worker and lead evidence: `server/index.test.ts` 72 passed,
  1 existing skip; focused 58/58; matrix 98/98; server/full TypeScript green;
- at B2 acceptance, porcelain was 121 for that active scope: four Stage 7B2
  entries and 117 preserved outside entries;
- the current B3 boundary remains porcelain 121: seven scope entries and 114
  preserved outside entries.

The correction was limited to the one allowlisted file and required no further
production or test correction. At that earlier B2 boundary, Stage 7B3 was the
declared implementation boundary; it was later accepted as recorded above.

## Verification checkpoint

Independent lead evidence records the 13-file unit matrix as 159 unique tests
green after one isolated kill-tree rerun. The initial parallel run had PID
output contention; the isolated rerun is the accepted evidence rather than
silently treating that contention as a product failure. Additional accepted
evidence is:

- `server/index.test.ts`: 72 passed, 1 skipped;
- communications suite: 19/19;
- frontend and server TypeScript checks: green;
- `git diff --check`: green.
- A1 worker focused acceptance: 2 passed, 33 skipped;
- A1 worker full `server/delegations.test.ts`: 35/35;
- A1 worker full `server/store.test.ts`: 55/55;
- independent lead combined delegations and store evidence: 90/90;
- independent server TypeScript and diff-integrity checks: passed.
- Phase 6A worker focused Windows CUA evidence: 22 passed, 1 Linux-only
  skipped; updater coordinator: 15/15; server and full TypeScript checks: green;
  five-file diff/scope check: green.
- Phase 6A independent lead repetition: 22 passed, 1 Linux-only skipped;
  updater coordinator: 15/15; both TypeScript checks and Node syntax checks:
  green.
- The lead's real local Windows CUA 0.21.0 probe and end-to-end descriptor
  decode passed. The canonical target resolved to its concrete release file;
  doctor emitted a transient UIA warning and correctly remained
  degraded-ready.
- Phase 6B worker and lead evidence: `server/env-path.test.ts` 14 passed and
  8 expected POSIX skips on Windows; both TypeScript checks, diff integrity,
  and two-file scope checks passed; status remained 118.
- Phase 6C worker and independent lead evidence: release tests 9/9;
  `electron/android-device.test.mjs` 4/4; Node syntax checks for all three
  allowlisted JavaScript files, server and full TypeScript checks, and
  `git diff --check` passed. Default porcelain was 121: three 6C entries
  plus 118 preserved outside entries; `dist-native` status remained 0.
- Phase 6C used no network, product build, or workspace `dist-native`
  mutation. One test-fixture-only correction changed a Windows file-symlink
  fixture to junction rejection because unprivileged Windows symlink creation
  was denied; the final suite is green and no product behavior was weakened.
- Stage 7 read-only audit baseline: five files, 66/66; no credentials, OAuth,
  quota, or external network. The five reproduced gaps and Stage 7A hashes,
  invariants, and residual boundaries are recorded above.

Skills and lifecycle acceptance is recorded in the existing worker and lead
receipts; no additional counts are inferred here.

## Store task selection contract

`Store.activeTask(botId)` returns the task whose thread is currently selected
by that bot. It is not a running-only query and may correctly return a terminal
task. A1 therefore checks the selected fresh thread, completed terminal
receipt/eventId, settled handoff state, empty delegation queue, and `busy=false`.

## Intentional dirty checkout

The dirty checkout is intentional and must be preserved. The current observed
default porcelain count is 121 entries. Historical accepted Stage 7A/7B1 scope
was four files: `server/custom-endpoints.ts`,
`server/custom-endpoints.test.ts`, `server/drivers/acp/opencode-go.ts`,
and `server/drivers/acp/opencode-go.test.ts`. All four are already dirty or
untracked. The current accepted Stage 7B2 scope was the four paths recorded
above. The accepted Stage 7B3 implementation scope is the seven paths recorded
above, with 114 preserved outside entries; porcelain remains 121. No ownership
union is inferred across historical scopes.
The earlier Phase 6C three-file/118-outside, Phase 6A
five-file/113-outside, and
runtime-2B 17/99 counts are historical checkpoints, not current ownership
counts. Never infer ownership beyond the accepted allowlists. Do not reset,
clean, revert, overwrite, or claim unrelated diffs.

## Remaining DoD gap matrix

| State | Gap or evidence boundary |
| --- | --- |
| Proven | Fresh handoff without parent history; stable routing-key resolution; conflicting-writer rejection; durable, restart, late, and duplicate lifecycle handling; the same persistent worker across sequential fresh delegations; provider/model A to B preserves the stable `routingKey` and canonical bot id; each dispatch receives a distinct fresh thread without source or old-target history; disjoint scopes launch concurrently while an overlapping third handoff is rejected before `runTarget`; Phase 6A Windows CUA file-identity supervision; Phase 6B removal of implicit donor-runtime discovery; Phase 6C Android Platform Tools supply pinning and validation; the existing credential-safe substrate and opt-in model discovery baseline. |
| Proven at the existing boundary | Updater isolation for explicit download/install, coordinator evidence 15/15, pinned release commit/actions/frozen lock, feed hash/size verification, and the Antigravity helper boundary. |
| Deferred | Unsigned Windows publisher authenticity remains deferred because signing requires an external certificate and credentials. No credentials are requested or used. It is separate external trust work and has no implementation assignment. |
| Proven | Stage 7A secret-safe, bounded, per-profile model discovery in the exact four-file scope above. |
| Proven at audit boundary | Stage 7B read-only audit: OpenCode config precedence, Stage 7B2 URL safety/migration evidence, and Stage 7B3 registry/transaction evidence recorded above. |
| Proven | Stage 7B2 safe endpoint URL validation, legacy sanitization, atomic migration, and defense-in-depth consumers in the exact four-file scope above. |
| Proven | Stage 7B3 exact server/Electron transaction, credential reconciliation, preflight taxonomy, and Windows sharing-violation regression in the exact seven-file scope above. |

## Final bounded roadmap recommendation

The bounded roadmap checkpoint is complete across all seven declared product
stages. Do not invent a Stage 8 or assign another implementation slice. The
only remaining deferred item is unsigned Windows publisher authenticity,
which requires a separate user-authorized certificate/credential decision;
no implementation assignment is made and no credentials are requested.

## Custom v22 source-integration maintenance checkpoint

This is maintenance of the custom v22 baseline, not Stage 8. The custom app
may check the official `milind-soni/openmausbot-releases` feed for developer
versions, but direct binary download and installation are fail-closed. An
upstream release is integrated only on an isolated `codex/integrate-*` branch,
tested, packaged to staging, and safely swapped after verification; there is
no automatic merge and the official installer never runs over the custom build.

The accepted lead evidence for 2026-08-27 is:

- only `release-codex-local-v22` remains;
- updater coordinator tests: 22/22;
- client and server TypeScript checks and Node syntax checks: green;
- packaged `app.asar` contains the fixed GitHub feed
  `owner: milind-soni`, `repo: openmausbot-releases`, and
  `mode: source-integration`;
- packaged-server smoke: 8/8 resolved proxy paths;
- `OpenMausBot.exe` SHA-256:
  `78D22BD90CE12674F0C8B3EC014FA1FFC794B070AD1414AC3A565C09C34DEE29`;
- `resources/app.asar` SHA-256:
  `FA6C9E7AA619CC8FB2FAD78475C2E1B122A21754B9DF03D2EB0533AA730F6246`;
- `resources/server/index.js` remains
  `94E8A1EEEBD6B335F3F486A5AD397D94538ED04F9BFA95FE6660BE58D1B090DA`;
- phone-harness manifest and `SKILL.md` hashes remain
  `A6610623D393324BC1A7BFEC6B0D2FC6333580859E25F0E3FA4C2469C4BD1B46` and
  `11CD48E61571DF82A4B6A2A369F2F84BDFE7179F1D6A928E9A1091982C23BD56`.

## Custom v23 app-wide Skills acceptance and promotion

Custom v23 was accepted and promoted on 2026-08-27. This is a maintenance
baseline after the completed seven-stage roadmap, not a new product stage.
The historical custom v22 evidence above remains the evidence for that earlier
baseline.

The accepted Skills contract is one app-wide workflow over the existing
`server/skill-library.ts` and `skills/phone-harness` substrate:

- Settings has one searchable library for bundled, recorded, and globally
  imported skills. A global import is installed once. Full-batch preflight
  rejects invalid, reserved, existing, and intra-batch duplicate IDs before
  the first write.
- Composer button, `/skills`, and `/skills <query>` open the same searchable
  selector. Direct chats and rooms carry at most one scalar `skillId` for the
  next accepted send or queue entry, display a removable selection pill, and
  clear it only after admission.
- Selection is strictly manual by default. Ordinary text and historical
  `triggerTerms` do not select a skill. There is no multiple or implicit room
  selection.
- Generic skills are provider-neutral. Declared capabilities are checked from
  all runtime flags whose values are literally `true`; declared skill tools
  remain subject to hidden authoritative per-bot grants, and only the selected
  skill's granted tools are exposed.
- Unknown, skill-denied, capability-missing, and tool-denied admission failures
  have stable refusal reasons. Manual success and refusal audit records do not
  contain prompts or secrets.
- Legacy per-bot imported data, enable flags, and
  `/api/bots/:id/skills*` routes remain compatible. Retired managed
  `.claude/.agents/.grok` discovery directories are removed rather than
  recreated, and legacy skill prompts are not injected into dispatch, so there
  is no second runtime registry.

The exact accepted 17-file source scope is:

- `server/index.test.ts`;
- `server/index.ts`;
- `server/skill-audit.test.ts`;
- `server/skill-library.test.ts`;
- `server/skill-library.ts`;
- `server/skills.test.ts`;
- `server/skills.ts`;
- `server/steer-queue.test.ts`;
- `server/steer-queue.ts`;
- `src/components/Composer.tsx`;
- `src/components/SettingsModal.tsx`;
- `src/components/SettingsPanel.tsx`;
- `src/components/SkillsDialog.tsx`;
- `src/components/SkillsSection.tsx`;
- `src/lib/skills.test.ts`;
- `src/lib/skills.ts`;
- `src/state/store.tsx`.

Accepted fake/local verification evidence:

- focused six-file Skills matrix: 6 files passed, 131 tests passed, 1 existing
  Windows platform skip;
- `server/index.test.ts`: 94 passed, 1 existing Windows platform skip;
- import-atomicity matrix: 107 passed, 1 existing platform skip, including
  `server/skills.test.ts` at 13/13;
- server and full TypeScript `--noEmit`: passed;
- full `pnpm test`: Vitest 198 files passed and 12 skipped, with 2174 tests
  passed and 92 skipped; broker 7/7, updater 22/22, desktop viewer 5/5,
  package-link 2/2, save-file 7 passed with 3 platform skips, and packaged
  server smoke passed with all 9 proxy paths inside its packaged directory;
- `pnpm check:contrast`: 21 pairs checked, no new failures, 3 carried
  exceptions;
- tracked and untracked whitespace checks and exact scope checks: passed.

Repository-wide `pnpm lint` reports 1901 pre-existing anti-slop diagnostics
across the integrated baseline and is recorded as non-gating for this release;
the new standalone Skills UI/library files pass their focused oxlint check.

Independent visual browser/DOM proof against v23 confirmed Settings to Skills,
the searchable library and import metadata, the composer `Choose a skill`
dialog, filtering to and selecting exactly `Phone Harness`, the removable
next-message pill, `/skills`, and `/skills phone`. No provider message or
import was sent during that proof.

Fresh Windows packaging completed through `pnpm package:prepare` and
`electron-builder --win dir --publish never`. Packaged-server smoke ran against
the staged `resources/server` without reachable `node_modules` and kept all 9
proxy paths inside the packaged tree. Packaged UI/server markers proved the
Skills library, `/skills`, exact manual selector, capability mapping, atomic
import, and stable refusal paths. Accepted SHA-256 values are:

- `OpenMausBot.exe`:
  `4368CCE59E02E32DFFC1D2C218AF3AE8F0386661938E50E938F133EA0BA15B12`;
- `resources/app.asar`:
  `31803E0894D3B868ED2DAB945F6FC3F24069B2C8EAE9AB3C114518409F2BA63D`;
- `resources/server/index.js`:
  `6F96BFE655602466F06D2E644C2BFDCAC3700A7E57A9964FBAD77175799AEFD3`;
- `resources/skills/phone-harness/manifest.json`:
  `A6610623D393324BC1A7BFEC6B0D2FC6333580859E25F0E3FA4C2469C4BD1B46`;
- `resources/skills/phone-harness/SKILL.md`:
  `11CD48E61571DF82A4B6A2A369F2F84BDFE7179F1D6A928E9A1091982C23BD56`.

Promotion moved the verified staging directory, without copying or rebuilding,
to `D:\Codex\OpenMausBot-custom\release-codex-local-v23`. Both the Desktop
and Start Menu shortcuts have COM-read-back target, working directory, and icon
paths under that final root. The staging and custom v22 release directories are
absent; custom v22 was removed only after final-root and shortcut proof.

The accepted running snapshot has 8 OpenMausBot/cloudflared processes, all
under the final v23 root and none outside it. The local listener at
`127.0.0.1:8799` returned HTTP 200 with
`{"app":"openmausbot","pid":25836,"static":true}` and its listener owner
matched that packaged server PID. Unsigned Windows publisher authenticity
remains deferred external trust work requiring separate certificate and
credential authority; no signing credentials were requested or used.
