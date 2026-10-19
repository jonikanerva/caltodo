// The color contrast of the primary and destructive buttons, the destructive
// toast, the footer, and the header navigation in both themes (issue #5,
// item 14). The other journeys check most pages in the light theme only.
import type { Page } from "@playwright/test"
import { expect, expectNoAxeViolations, test } from "./support.js"

const THEMES = ["light", "dark"] as const
type Theme = (typeof THEMES)[number]

// Opens the page in a theme. The app reads the theme from local storage.
const openInTheme = async (page: Page, path: string, theme: Theme): Promise<void> => {
  await page.addInitScript((value: string) => {
    localStorage.setItem("theme", value)
  }, theme)
  await page.goto(path)
  await expect
    .poll(() => page.locator("html").evaluate((html) => html.classList.contains("dark")))
    .toBe(theme === "dark")
}

for (const theme of THEMES) {
  test.describe(`signed out, ${theme} theme`, () => {
    test.use({ storageState: { cookies: [], origins: [] } })

    test("the sign-in page passes axe", async ({ page }) => {
      await openInTheme(page, "/", theme)
      await expect(page.getByText("Welcome to Todo", { exact: true })).toBeVisible()
      await expect(page.getByTestId("button-google-signin")).toBeVisible()
      await expectNoAxeViolations(page)
    })

    test("the privacy page passes axe", async ({ page }) => {
      await openInTheme(page, "/privacy", theme)
      await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible()
      await expectNoAxeViolations(page)
    })
  })

  test(`the settings page passes axe in the ${theme} theme`, async ({ page }) => {
    await openInTheme(page, "/settings", theme)
    await expect(page.getByTestId("button-save-settings")).toBeVisible()
    await expect(page.getByTestId("button-delete-data")).toBeVisible()
    await expectNoAxeViolations(page)

    // The confirmation dialog has a second destructive button.
    await page.getByTestId("button-delete-data").click()
    const dialog = page.getByRole("alertdialog")
    await expect(dialog.getByRole("button", { name: "Delete all data" })).toBeVisible()
    await expectNoAxeViolations(page)
    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toHaveCount(0)

    // A failed save shows the destructive toast. The route answers in the
    // browser only, so the saved settings of the shared account stay.
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.fallback()
        return
      }
      await route.fulfill({
        status: 500,
        contentType: "application/problem+json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Internal Server Error",
          status: 500,
          detail: "Internal server error",
          code: "internal_error",
        }),
      })
    })
    await page.getByTestId("button-save-settings").click()
    await expect(
      page.getByText("Failed to save settings. Please try again.", { exact: true }),
    ).toBeVisible()
    await expectNoAxeViolations(page)
  })
}

// The removed allowlist entries must not hide a new defect: a low contrast
// on the footer, or a header link without a name, fails the check.
test("a low-contrast footer is a violation", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible()
  await page.locator("footer p").evaluate((footer) => {
    footer.style.color = "rgb(200, 200, 200)"
  })
  await expect(expectNoAxeViolations(page)).rejects.toThrow(/color-contrast/)
})

test("a header link without a name is a violation", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible()
  await page.getByTestId("nav-settings").evaluate((button) => {
    for (const label of button.querySelectorAll("span")) label.remove()
  })
  await expect(expectNoAxeViolations(page)).rejects.toThrow(/link-name|button-name/)
})
