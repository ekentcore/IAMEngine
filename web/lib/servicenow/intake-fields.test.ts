import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchIntakeFields, formatIntakeFields } from "./intake-fields";
import type { SnConfig } from "./types";

const config: SnConfig = { instanceUrl: "https://x.service-now.com", username: "u", password: "p" };

// Mock both SN calls: the sys_dictionary lookup, then the record (display_value=all).
function mockFetch(): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    const result = u.includes("sys_dictionary")
      ? [
          { element: "u_first", column_label: "First" },
          { element: "u_last", column_label: "Last" },
          { element: "u_personal_email", column_label: "Personal Email" },
          { element: "u_email_address_needed", column_label: "Email Address Needed" },
          { element: "u_collect_cell_phone", column_label: "Collect Cell Phone" },
          { element: "u_product_licenses", column_label: "Product Licenses" },
        ]
      : [
          {
            number: { value: "UM1", display_value: "UM1" },
            u_first: { value: "Kate", display_value: "Kate" },
            u_last: { value: "Von Dohlen", display_value: "Von Dohlen" },
            u_personal_email: { value: "", display_value: "" },
            u_email_address_needed: { value: "true", display_value: "true" },
            u_collect_cell_phone: { value: "false", display_value: "false" },
            u_product_licenses: { value: "01e,52d", display_value: "Microsoft 365 E3, Copilot" },
          },
        ];
    return { ok: true, status: 200, json: async () => ({ result }) } as Response;
  }) as unknown as typeof fetch;
}

test("splits filled vs blank; false/empty are blank; references use display names", async () => {
  const b = await fetchIntakeFields(config, "UM1", mockFetch());
  assert.ok(b);
  assert.deepEqual(b!.filled.map((f) => f.name).sort(), ["u_email_address_needed", "u_first", "u_last", "u_product_licenses"]);
  assert.deepEqual(b!.empty.map((e) => e.name).sort(), ["u_collect_cell_phone", "u_personal_email"]);
  assert.equal(b!.filled.find((f) => f.name === "u_email_address_needed")!.value, "yes"); // bool true -> yes
  assert.equal(b!.filled.find((f) => f.name === "u_product_licenses")!.value, "Microsoft 365 E3, Copilot"); // display, not sys_ids
});

test("formatIntakeFields renders FILLED IN + NOT FILLED IN sections", () => {
  const out = formatIntakeFields({
    number: "UM1",
    filled: [{ name: "u_first", label: "First", value: "Kate" }],
    empty: [{ name: "u_personal_email", label: "Personal Email" }],
  });
  assert.match(out, /FILLED IN \(1\):/);
  assert.match(out, /First\s+Kate/);
  assert.match(out, /NOT FILLED IN \(1\):/);
  assert.match(out, /Personal Email/);
});
