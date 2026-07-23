# @vorionsys/runtime

## 0.1.6

### Patch Changes

- c946540: docs: refresh published README (registry-truth pass — dead links, deprecated install guidance)

## 0.1.5

### Patch Changes

- 19bd0a5: Bump `@vorionsys/shared-constants` dependency to `^2.0.0`. The 2.0.0 major only removed the unused `manifest` export and added `tier-reconciliation`; runtime consumes only tier exports (`TIER_THRESHOLDS`, `scoreToTier`), so there is no API change.

## 0.1.4

### Patch Changes

- 5a08e14: Add npm provenance attestation, trusted publisher configuration, and correct package metadata (homepage, bugs, author, files).
