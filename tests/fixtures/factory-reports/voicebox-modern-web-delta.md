# Software Factory Delta Report: voicebox
Generated: 2026-10-07T19:32:36.486035+00:00

| New | Regressed | Fixed | Unchanged | Suppressed | False positive |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **1** | **0** | **0** | 0 | 0 | 0 |

## Action Required: New & Regressed Findings

### [LOW] Popup close handler predates the popover API (`new`)
- **Rule**: `legacy-light-dismiss`
- **Location**: `public/style.css:88`
- **Fingerprint**: `68745c29eb9f51b8...`
- **Description**: a legacy manual light-dismiss handler
- **Snippet**: `element.addEventListener('click', closePopup)`
- **Remediation**: Use the native popover light-dismiss
