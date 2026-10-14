// Signs in once through the fake Google sign-in and stores the session for
// the other projects. The sign-in page is checked on the way.
import { STORAGE_STATE } from "./servers.js"
import { expect, expectNoAxeViolations, test } from "./support.js"

test("signs in with Google", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("Welcome to Todo", { exact: true })).toBeVisible()
  await expectNoAxeViolations(page)
  await page.getByTestId("button-google-signin").click()
  await expect(page.getByTestId("nav-tasks")).toBeVisible()
  await expect(page.getByTestId("alert-no-calendar")).toBeVisible()
  // The journeys need a calendar; the settings journey checks the form.
  await page.getByRole("link", { name: "Go to Settings" }).click()
  await page.getByTestId("select-calendar").click()
  await page.getByRole("option", { name: "E2E Calendar (Primary)" }).click()
  await page.getByTestId("button-save-settings").click()
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible()
  await page.context().storageState({ path: STORAGE_STATE })
})
