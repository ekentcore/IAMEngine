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
