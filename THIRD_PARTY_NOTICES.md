# Third-party notices

## OpenMausBot

The upstream OpenMausBot source is distributed under Apache License 2.0. See [`LICENSE`](LICENSE) and the upstream repository: <https://github.com/milind-soni/OpenMausBot>.

## Blobatar

This fork uses `blobatar` and `@blobatar/react` version 2.7.0. Their package metadata identifies them as MIT-licensed. Preserve the package copyright and license notices when distributing builds.

## Avatar provenance blocker

`src/lib/avatar-presets.ts` contains exported avatar definitions used by Avatar Lab. The current audit has not proven whether the donor material associated with Bible Strong Avatar Lab is permitted for this repository. The cited project is understood to use AGPL-3.0, but this file does not establish permission or a compatible provenance record. This is an unresolved publication blocker, not a legal conclusion. Obtain provenance and permission evidence, replace the data, or exclude the affected material before publishing a fork.

## CI secret-scan action

No GitHub Actions secret-scan workflow is included in this gate. An official action with a verified immutable
commit SHA and no repository secret was not established from the available evidence. Revisit this before
publishing CI changes.
