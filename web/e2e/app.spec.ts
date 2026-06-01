import { test, expect } from "@playwright/test";

test.describe("clients list", () => {
  test("loads with header + a populated table", async ({ page }) => {
    await page.goto("/clients");
    await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
    await expect(page.getByText(/\d+ total/)).toBeVisible();
    expect(await page.locator("tbody tr").count()).toBeGreaterThan(10);
  });

  test("modeled filter narrows to fewer (but >0) clients", async ({ page }) => {
    await page.goto("/clients");
    const all = await page.locator("tbody tr").count();
    await page.locator('select:has(option[value="modeled"])').selectOption("modeled");
    await expect.poll(async () => page.locator("tbody tr").count()).toBeLessThan(all);
    const modeled = await page.locator("tbody tr").count();
    expect(modeled).toBeGreaterThan(0);
  });

  test("search filters the list", async ({ page }) => {
    await page.goto("/clients");
    await page.getByPlaceholder(/Search/).fill("six one");
    await expect.poll(async () => page.locator("tbody tr").count()).toBeLessThan(5);
    await expect(page.getByText(/Six One/i).first()).toBeVisible();
  });
});

test.describe("client detail — the runbook fix", () => {
  test("Six One shows systems and an expandable runbook with steps", async ({ page }) => {
    await page.goto("/clients/six-one");
    await expect(page.getByRole("heading", { name: /Six One/ })).toBeVisible();
    // systems table
    await expect(page.getByRole("heading", { name: "Systems", exact: true })).toBeVisible();
    await expect(page.getByText("(case-resolution)")).toBeVisible();
    // runbook section
    await expect(page.getByRole("heading", { name: /Runbook/ })).toBeVisible();
    const items = page.locator("details");
    expect(await items.count()).toBeGreaterThan(3);
    // expand the first item and confirm real runbook step bullets appear
    const first = items.first();
    await first.locator("summary").click();
    await expect(first.locator("div", { hasText: "•" }).first()).toBeVisible();
  });

  test("ad-synced user-creation steps (username/password) live in the AD section", async ({ page }) => {
    await page.goto("/clients/six-one");
    // Six One creates users in Active Directory; that section should carry the field steps.
    const ad = page.locator("details", { has: page.getByText(/active-directory —/) }).first();
    await ad.locator("summary").click();
    await expect(ad.getByText(/user|OU|group|password|account/i).first()).toBeVisible();
  });
});

test.describe("runbook upgrades", () => {
  test("Source KB link + numbered steps", async ({ page }) => {
    await page.goto("/clients/six-one");
    await expect(page.getByRole("link", { name: /onboard →/ }).first()).toBeVisible();
    await expect(page.locator("details summary").first()).toContainText(/^\s*\d+\./);
  });

  test("Expand all opens items; Collapse all closes them", async ({ page }) => {
    await page.goto("/clients/six-one");
    await page.getByRole("button", { name: "Expand all" }).first().click();
    expect(await page.locator("details[open]").count()).toBeGreaterThan(3);
    await page.getByRole("button", { name: "Collapse all" }).first().click();
    await expect.poll(async () => page.locator("details[open]").count()).toBe(0);
  });

  test("automated m365 item shows the intended-automation code block", async ({ page }) => {
    await page.goto("/clients/core507"); // ACORE — entra, m365 onboard automated
    const m365 = page.locator("details", { has: page.getByText(/m365 —/) }).first();
    await m365.locator("summary").click();
    await expect(m365.getByText(/Intended automation/i).first()).toBeVisible();
    await expect(m365.locator("pre code")).toContainText("$UserPrincipalName");
    await expect(m365.locator("pre code")).toContainText(/New-MgUser|Update-MgUser/);
  });
});

test.describe("KB-content enrichment", () => {
  test("verify/confirm instruction text is captured (ACORE dynamic groups)", async ({ page }) => {
    await page.goto("/clients/core507"); // ACORE
    const item = page
      .locator("details", { hasText: "Verify the user was added to the following dynamic groups" })
      .first();
    await item.locator("summary").click();
    // the instruction shows AND the group names nest under it
    await expect(item.getByText("Verify the user was added to the following dynamic groups:")).toBeVisible();
    await expect(item.getByText(/AAD-KnowBe4/).first()).toBeVisible();
  });

  test("LogicSource shows the OneMarket email template block", async ({ page }) => {
    await page.goto("/clients/core1748"); // LogicSource
    const item = page.locator("details", { hasText: "OneMarket Apps" }).first();
    await item.locator("summary").click();
    await expect(item.getByText("Email template (helpdesk)")).toBeVisible();
    await expect(item.getByText("New User Activation: OneMarket Apps")).toBeVisible();
    await expect(item.getByText(/helpdesk@logicsource\.com/)).toBeVisible();
  });

  test(".eml download serves an attachment with the right headers", async ({ request }) => {
    const res = await request.get("/api/clients/core1748/runbook/email?action=onboard&seq=1&i=0");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("message/rfc822");
    expect(res.headers()["content-disposition"]).toContain('filename="core1748-');
    const body = await res.text();
    expect(body).toContain("Subject: New User Activation: OneMarket Apps");
    expect(body).toContain("To: helpdesk@logicsource.com");
  });
});

test.describe("agents", () => {
  test("agents page renders and the enroll dialog opens", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Enroll agent" }).click();
    await expect(page.getByText(/central agent executes/i)).toBeVisible();
  });
});

test("clients list has no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/clients");
  await page.waitForLoadState("networkidle");
  expect(errors, errors.join("\n")).toEqual([]);
});
