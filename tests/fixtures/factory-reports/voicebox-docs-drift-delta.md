# Software Factory Delta Report: voicebox
Generated: 2026-10-07T19:32:36.485942+00:00

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **1** | **0** | **0** | 1 | 0 | 1 |

## Action Required: New & Regressed Findings

### [MEDIUM] Route table names a removed endpoint (`new`)
- **Rule**: `stale-route-table`
- **Location**: `docs/07-architecture.md:40`
- **Fingerprint**: `8a1d534b804960d9...`
- **Description**: the documented route no longer exists
- **Snippet**: `/api/legacy`
- **Remediation**: Regenerate the table

## Triaged False Positives (not counted, never published)

- **Second candidate on the same table** (`stale-route-table` at `docs/07-architecture.md:41`)
