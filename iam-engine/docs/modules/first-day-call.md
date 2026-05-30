## First-day call (`first-day-call`)

`Module: none (scheduled manual)` · `Mode: manual` · `Build tier: 3` · `Lanes: onboard`

A scheduled day-1 login check by the relevant pod (e.g. Finance) for some clients.

### Onboard lane
`always` (for clients that require it), `schedule{offsetDays:0}` — on the user's first day.
Create/assign a task for the pod to call the user at 2pm local time and confirm they can log
in with no issues.

### Config keys
`pod`, `callTimeLocal`, `schedule`.

### Functions
`Schedule-CtgFirstDayCall` (creates a dated task); execution is manual.

### Depends on
The onboard lane completing (user must be set up before the call).

### Variants & gotchas
Scheduled for the start date, not run-now; uses the same deferred-job mechanism as `archive`.

### Manual fallback
Manual by design (a person makes the call).
