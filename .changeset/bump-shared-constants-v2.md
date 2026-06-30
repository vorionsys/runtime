---
"@vorionsys/runtime": patch
---

Bump `@vorionsys/shared-constants` dependency to `^2.0.0`. The 2.0.0 major only removed the unused `manifest` export and added `tier-reconciliation`; runtime consumes only tier exports (`TIER_THRESHOLDS`, `scoreToTier`), so there is no API change.
