## Address book (`address-book`)

`Module: (Playwright in agent / manual)` · `Mode: browser` · `Build tier: 3` · `Appears in: few` · `Lanes: onboard`

Adding the new user to a network printer's address book via its web UI — device-specific,
no standard API.

### Auth
Secret: printer/host login (e.g. `ess-host` or a device credential). Run by the
client-network agent or manually.

### Onboard lane
`on-request`. Open the printer admin UI in a browser; add the user to the address book.

### Config keys
`host`, `printerConfigUrl`, `steps[]`.

### Functions
Playwright script (per device family) or manual checklist.

### Depends on
identity / email (the address being added).

### Variants & gotchas
Vendor-specific UI; Playwright only worth it for high-volume device families, else manual.

### Manual fallback
Primary fallback: the printer-UI step as a checklist item.
