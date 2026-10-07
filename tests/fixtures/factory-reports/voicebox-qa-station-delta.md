# Software Factory Delta Report: voicebox
Generated: 2026-10-07T19:32:36.485532+00:00

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **1** | **0** | **0** | 0 | 0 | 0 |

## Action Required: New & Regressed Findings

### [MEDIUM] Folder chip assertion waits on a load-sensitive timeout (`new`)
- **Rule**: `flake-instrumentation`
- **Location**: `tests/room-folders.test.mjs:96`
- **Fingerprint**: `5ad499cc4e91544e...`
- **Description**: the chip assertion is timing dependent under gate load
- **Snippet**: `await page.waitForSelector("text=Projects")`
- **Remediation**: Assert on the folder count instead of waiting for a chip
