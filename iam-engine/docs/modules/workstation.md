## Workstation (`workstation`)

`Module: none (manual / guided)` · `Mode: manual` · `Build tier: 3` · `Lanes: onboard`

New-device setup. Largely manual/on-site today; the engine tracks and gates it.

### Onboard lane
`on-request` (when a computer is requested). Use the Windows or Mac Setup Guide to configure
the machine. An on-site engineer verifies the build (monitors, camera, keyboard, mouse, the
whole unit). If an AVD is requested instead, use the AVD module rather than a physical build.

### Config keys
`onsiteEngineerCheck`, `avdAlternative`, `platform` (windows|mac).

### Functions
None — manual checklist; integrates with case-resolution (credentials/closeout wait on this).

### Depends on
none (but case-resolution waits on completion if a computer was requested).

### Variants & gotchas
Windows vs Mac; on-site coordination; AVD as the alternative path.

### Manual fallback
Manual by design.
