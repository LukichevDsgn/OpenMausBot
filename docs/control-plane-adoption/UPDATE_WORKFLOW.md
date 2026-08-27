# Custom v22 update workflow

1. Receive an official developer-release notification.
2. Identify the exact released source commit; never move `main`.
3. Fetch the required upstream references.
4. Create an isolated `codex/integrate-*` branch from the custom baseline.
5. Merge the exact released commit into that branch.
6. Resolve integration changes and run the required deterministic tests and checks.
7. Build the Windows unpacked release into a staging directory.
8. Verify the staged artifact, then safely swap it into the custom release directory.
9. Advance the custom baseline and tag only after the verified swap.

The official installer never runs over the custom build. Merging is never
automatic; a human-authorized isolated integration is required.
