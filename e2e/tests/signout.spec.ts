// Sign-out ends only the session of this browser.
import { expect, signIn, test } from "./support.js"

test.use({ storageState: { cookies: [], origins: [] } })

test("signs out to the sign-in page", async ({ page }) => {
  await signIn(page)
  await page.getByTestId("button-logout").click()
  await expect(page.getByText("Welcome to Todo", { exact: true })).toBeVisible()
  await page.goto("/settings")
  await expect(page.getByText("Welcome to Todo", { exact: true })).toBeVisible()
})
