# Software Factory Delta Report: voicebox
Generated: 2026-10-07T19:32:36.485721+00:00

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **1** | **0** | **0** | 0 | 0 | 0 |

## Action Required: New & Regressed Findings

### [MEDIUM · routed critical] Hard-coded API key committed (`new`)
- **Rule**: `generic-api-key`
- **Location**: `config/example.env:12`
- **Fingerprint**: `fa3c21d55bc1101d...`
- **Description**: a credential-shaped value is present in the tree
- **Snippet**: `API_KEY="CANARY-fixture-not-a-real-credential"`
- **Remediation**: Rotate the value and move it out of the repository
