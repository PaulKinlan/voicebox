# Software Factory Delta Report: voicebox
Generated: 2026-10-07T19:32:36.485838+00:00

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **1** | **0** | **0** | 0 | 0 | 0 |

## Action Required: New & Regressed Findings

### [HIGH] Startup probe blocks the boot banner (`new`)
- **Rule**: `blocking-boot-probe`
- **Location**: `server.mjs:210`
- **Fingerprint**: `5939431590a57344...`
- **Description**: the probe is awaited before the banner prints
- **Snippet**: `await probeAll()`
- **Remediation**: Do not await the probe before printing the banner
