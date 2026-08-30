# Security Policy

This policy applies to the unofficial OpenMausBot-custom fork. For vulnerabilities that clearly affect
upstream OpenMausBot, also follow the [upstream security policy](https://github.com/milind-soni/OpenMausBot/security).

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use this fork's GitHub private vulnerability
reporting if enabled, or the private contact listed by the repository owner. Do not publish a personal
email address in copied documentation unless the owner has explicitly designated it as the security contact.
Include impact, reproduction, affected commit, and proposed mitigation.

## Scope notes for researchers

- The harness server binds **127.0.0.1 only** and has no authentication by design — it trusts the
  local user. Anything that makes it reachable from off-machine, or lets one local *unprivileged
  other user* drive it, is a vulnerability.
- API keys live in `~/.openmausbot/config.json` and are write-only through the API (`configured`
  booleans out, never values). Any path that echoes a stored secret back — API response, SSE event,
  log line, argv visible in `ps` — is a vulnerability.
- Agents run real CLIs (`claude`, `codex`) with the user's own privileges, and the permission broker
  is the consent layer for risky actions. Bypasses of the broker (approving without a user decision,
  spoofing the broker socket) are vulnerabilities.
- Spawning must never route user-influenced strings through a shell. Report any `shell: true` /
  `cmd.exe` string-building you find.

## Publication and credential hygiene

- Never commit `.env` files, `.npmrc`, `~/.openmausbot` contents, local runtime/config files, provider
  credentials, signing keys, release output, or Playwright session state. Safe `*.example` templates are
  allowed when they contain placeholders only.
- Run `pnpm check:secrets` before sharing a branch. It scans tracked files and untracked non-ignored
  publication candidates and prints only redacted fingerprints.
- If a secret was committed, stop distribution, revoke or rotate it with the provider, invalidate related
  sessions, remove it from current files and history as an agreed remediation, then rerun the scan. Do
  not paste the old value into an issue, chat, or PR.

## Runtime boundary

Provider keys are stored in local runtime configuration under `~/.openmausbot` and are write-only at the
API boundary: clients receive configured flags, not secret values. `safeStorage` or equivalent OS keychain
protection is a runtime concern; it does not make committed configuration safe. Report any path that
serializes a stored secret into UI state, HTTP/SSE output, logs, argv, fixtures, or diagnostics.
