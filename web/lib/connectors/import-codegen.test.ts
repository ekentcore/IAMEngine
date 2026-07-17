import { test } from "node:test";
import assert from "node:assert/strict";
import { importCodegen } from "./import-codegen";

test("parses a typical codegen script into steps + startUrl", () => {
  const script = `
    import { test, expect } from '@playwright/test';
    test('test', async ({ page }) => {
      await page.goto('https://portal.vendor.com/login');
      await page.getByLabel('Email').fill('admin@vendor.com');
      await page.getByLabel('Password').fill('hunter2');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByPlaceholder('Search users').fill('jane@medipost.com');
      await page.getByText('Deactivate').click();
      await expect(page.getByText('User deactivated')).toBeVisible();
    });
  `;
  const r = importCodegen(script);
  assert.equal(r.startUrl, "https://portal.vendor.com/login");
  assert.equal(r.unrecognized.length, 0);
  assert.deepEqual(r.steps[0], { type: "goto", url: "https://portal.vendor.com/login" });
  assert.deepEqual(r.steps[1], { type: "fill", target: { label: "Email" }, value: "admin@vendor.com" });
  assert.deepEqual(r.steps[3], { type: "click", target: { role: "button", name: "Sign in" } });
  assert.deepEqual(r.steps[4], { type: "fill", target: { placeholder: "Search users" }, value: "jane@medipost.com" });
  assert.deepEqual(r.steps[6], { type: "expect", target: { text: "User deactivated" } });
});

test("handles locator(css), press, and testId", () => {
  const script = `
    await page.locator('#search').fill('x');
    await page.getByTestId('submit').click();
    await page.getByLabel('Code').press('Enter');
  `;
  const r = importCodegen(script);
  assert.deepEqual(r.steps[0], { type: "fill", target: { css: "#search" }, value: "x" });
  assert.deepEqual(r.steps[1], { type: "click", target: { testId: "submit" } });
  assert.deepEqual(r.steps[2], { type: "press", target: { label: "Code" }, value: "Enter" });
});

test("collects lines it cannot parse instead of dropping them silently", () => {
  const script = `
    await page.goto('https://x.com/login');
    await page.evaluateHandle(() => window);
    await page.getByRole('button').dragTo(page.locator('#z'));
  `;
  const r = importCodegen(script);
  assert.equal(r.steps.length, 1); // only the goto
  assert.ok(r.unrecognized.some((l) => l.includes("dragTo")));
});
