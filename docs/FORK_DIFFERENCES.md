# What this fork changes

This is a source-only, unofficial fork based on OpenMausBot 0.1.39. The map below describes the current
checkout, not an upstream promise. Each section separates user-facing guidance from behavior enforced by
the server, companion, renderer, or tests.

## Coordination, receipts, and safe writes

| Original upstream | Custom fork | User benefit |
| --- | --- | --- |
| A chat turn and its agent process are the primary unit of work | Team/task flows add deterministic delegation, explicit completion receipts, evidence/status summaries, and reconciliation paths across `server/`, MCP, and control-plane code | A multi-step request can be followed, checked, and handed back with a concrete receipt |
| Repeated requests can otherwise create duplicate work or competing updates | Request IDs, idempotent control-plane operations, version checks, conflict errors, patch queues, and reconciliation tests cover duplicate, interrupted, and stale-writer cases (`cloudflare/control-plane/test/managed-endpoints.test.ts`, `cloudflare/control-plane/test/bot-shares.test.ts`, `src/state/store.test.ts`) | Retries are less likely to create duplicate resources or silently overwrite newer state |
| Agent prompts describe how a team should coordinate | Package Markdown and playbooks provide role ownership, completion rules, conflict-resolution guidance, and approval boundaries in `server/bot-package.ts` | Other agents can understand the intended workflow even without this app |

The playbook is guidance. Request identity, version conflicts, server schemas, serialized patches, and
permission boundaries are enforcement. A prompt cannot authorize a credential, approval, deletion, or
computer action.

## Runtime policy, Chief, and task overrides

| Original upstream | Custom fork | User benefit |
| --- | --- | --- |
| A bot has a provider/model configuration | Bots expose a per-bot Runtime Policy and effective policy synchronization in `src/state/store.tsx`, server profile/config code, and related tests | Each bot can have explicit execution limits instead of inheriting an ambiguous global default |
| Chief-of-Staff behavior is a role description | Chief status is section-scoped in the reducer and the Chief runtime policy lock is represented and tested (`src/state/store.test.ts`) | A Chief can coordinate without accidentally changing a locked runtime policy |
| A task normally follows the bot policy | Task-level model/effort/provider selection and override fields are carried through task and turn APIs | One bounded task can use a deliberate exception without rewriting the bot profile |

The role instructions are guidance. Effective policy calculation, Chief lock state, schema validation, and
server-side turn configuration are runtime behavior; the UI must not infer permission from labels alone.

## Provider routing

| Original upstream | Custom fork | User benefit |
| --- | --- | --- |
| Upstream drivers center on Claude/Codex and the existing agent harness | The custom driver registry and tests cover Codex, OpenCode Go, Hermes, Antigravity, Grok, and custom OpenAI-compatible endpoints; provider-specific files live under `server/drivers/` and configuration in `server/` | Users can route different bots to the CLI or compatible endpoint already available to them |
| Provider selection is mostly a configuration choice | Driver decoding, unavailable states, spawn/transport handling, model catalogs, and provider contract tests are enforced by the harness | A missing CLI or invalid configuration degrades to an explicit unavailable/error state instead of pretending a turn ran |

Provider names in a team document are guidance. Driver registration, config schemas, argv/environment
hygiene, and runtime event normalization are enforced. This fork does not provide provider entitlement or
proxy a user's subscription.

## Skills and reusable manual tools

| Original upstream | Custom fork | User benefit |
| --- | --- | --- |
| Skills are primarily discovered from the app's existing surface | A global manual Skills library supports local/research entries, import, delete, multi-select actions, audit/status views, and a Skills UI in `src/components/SkillsSection.tsx` and `src/components/SkillsDialog.tsx` | Reusable instructions can be inspected and managed without attaching them to one bot |
| A skill description is ordinary instruction text | Skill parsing, URL/file import boundaries, catalog state, and delete/update APIs are validated in `server/skills.test.ts`, `server/skill-library.test.ts`, and `src/lib/skills.test.ts` | Invalid or duplicate library records are handled predictably |

Skill content is guidance. Import validation, catalog mutation, access boundaries, and the absence of
credential material in packages are enforcement.

## Windows Computer, CUA, and phone harness

| Original upstream | Custom fork | User benefit |
| --- | --- | --- |
| Desktop computer use is primarily the existing cloud/macOS/Linux surface | Electron and server code add Windows screen-preview/window chrome paths, local CUA/runtime checks, and platform-gated computer capabilities; tests include `electron/screen-preview.test.mjs`, `electron/window-chrome.test.mjs`, and server computer tests | Windows development can inspect and drive the local computer path where the platform permits it |
| The desktop is the only client surface | `companion/` provides a paired-phone harness, device registry, authenticated proxy, routes, and revocation flows; tests cover pairing, replay, disconnect, and restricted routes | A phone can observe the approved companion surface without receiving desktop credentials |

UI copy about capability is guidance. Platform gates, loopback/LAN checks, pairing credentials, route
allowlists, revocation, and fail-closed behavior are enforced by Electron, server, and companion code.

## Source updater and local diagnostics

| Original upstream | Custom fork | User benefit |
| --- | --- | --- |
| Updates and diagnosis are mostly release/app concerns | The renderer exposes updater state, while `scripts/openmaus-doctor.mjs` and its tests compare health/status and watched artifact hashes | A source checkout can diagnose identity/readiness and detect a runtime/build mismatch |
| Release output is treated as a distributable build | This fork documents source-only status and keeps release/runtime output outside publication candidates | Contributors do not mistake a local or unsigned build for an official release |

Updater status and doctor checks are runtime evidence. Documentation or a release note is not proof that an
update was applied.

## Teams, scoped sharing, and Grok boundary

| Original upstream | Custom fork | User benefit |
| --- | --- | --- |
| Team setup is local to the app | Team export/import is scoped to Markdown package fields and has review, validation, connector checklist, paused-routine, and portable-playbook flows in `server/bot-package.ts`, `src/lib/team-import.ts`, and tests | A team blueprint can be shared without exporting credentials, transcripts, permissions, or computer access |
| A public Grok link might be mistaken for a complete private export | `server/grok-bot-template.ts` accepts the exact public x.ai/app-link forms and tests the parser/fetch boundary; unavailable entitlement is not treated as private/full recipe access | Users get a clear public-profile limitation instead of a false promise |
| Shared packages need conflict handling | Control-plane bot shares validate package shape, scoped fields, active versions, and return explicit version/share conflicts (`cloudflare/control-plane/src/bot-shares.ts`, tests) | Updating a shared package is reviewable and stale updates do not silently replace the active version |

Package activation text is guidance. Schema validation, field allowlists, credential exclusion, review state,
version checks, and public-link parsing are enforcement. Public x.ai access does not imply Grok entitlement.

## Storybook and redesigned UI

| Original upstream | Custom fork | User benefit |
| --- | --- | --- |
| UI changes are shown mainly through the running app | `src/stories/`, static fixtures, network guards, and Storybook tests cover redesigned chat, team map, policies, skills, phone, avatar, and control surfaces | Reviewers can inspect repeatable states without real providers or quota |
| Visual behavior is coupled to live server state | Storybook fixtures explicitly model locked Chief, running tasks, skill catalog, and team-map states (`src/storybook/fixtures.ts`, `src/storybook/storybook.test.ts`) | UI review is deterministic and safe to run offline |

Storybook fixtures are presentation guidance and test scaffolding. They do not prove that a live provider,
computer, entitlement, or release build is available.

## Blobatar avatars

| Original upstream | Custom fork | User benefit |
| --- | --- | --- |
| Existing mascot/avatar rendering | `blobatar` and `@blobatar/react` 2.7.0 plus Avatar Lab, procedural silhouettes, expressions, crops, and persisted definitions in `src/components/AvatarLabDialog.tsx`, `src/lib/avatar-presets.ts`, `src/lib/procedural-avatar.ts`, and `shared/bot-avatar.ts` | Bots can have distinct local visual identities and deterministic previews |
| Avatar data is not automatically publication-safe | Blobatar packages are recorded as MIT in `THIRD_PARTY_NOTICES.md`; exported donor preset provenance remains unresolved | Contributors have an explicit license audit boundary before sharing the fork |

Avatar labels and playbook descriptions are guidance. Schema validation, deterministic generation, persisted
definition handling, and renderer behavior are enforced. The unresolved donor-data provenance means this
repository must not be called safe to publish until evidence or replacement is recorded.

## Limitations

- This fork is source-only and has no custom binary release. Locally built Windows installers are unsigned.
- Public x.ai links do not promise private or full recipe retrieval without the required Grok entitlement.
- Windows CUA, phone harness, control-plane, updater, and local/research paths remain platform/configuration dependent.
- The repository still contains a large user-owned dirty diff. This document does not imply that every dirty file is in the publication scope.

## Evidence pointers

- Base: [`package.json`](../package.json), version `0.1.39`.
- Security gate: [`scripts/check-secrets.mjs`](../scripts/check-secrets.mjs), with default delta mode and explicit `--all` mode.
- Licensing: [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
