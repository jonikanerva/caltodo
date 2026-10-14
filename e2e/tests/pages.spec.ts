// The public pages, the not-found page, and the navigation.
import { expect, expectNoAxeViolations, test } from "./support.js"

test("the privacy and terms pages need no sign-in", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  await page.goto("/privacy")
  await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible()
  await expectNoAxeViolations(page)
  await page.getByRole("link", { name: "TOS" }).click()
  await expect(page).toHaveURL(/\/tos$/)
  await expectNoAxeViolations(page)
  await context.close()
})

test("an unknown path shows the not-found page", async ({ page }) => {
  await page.goto("/no-such-page")
  await expect(page.getByRole("heading", { name: "404 Page Not Found" })).toBeVisible()
})

test("the header navigates and toggles the theme", async ({ page }) => {
  await page.goto("/")
  await page.getByTestId("nav-settings").click()
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByTestId("nav-tasks").click()
  await expect(page).toHaveURL(/\/$/)
  const html = page.locator("html")
  const dark = await html.evaluate((element) => element.classList.contains("dark"))
  await page.getByTestId("button-theme-toggle").click()
  await expect
    .poll(() => html.evaluate((element) => element.classList.contains("dark")))
    .toBe(!dark)
  await expectNoAxeViolations(page)
})
