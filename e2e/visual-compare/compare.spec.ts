import { expect, test, type Page } from "@playwright/test"

test.describe.configure({ mode: "serial" })

const settle = async (page: Page): Promise<void> => {
  // Toasts disappear after a while; close them to compare the page itself.
  await page.keyboard.press("Escape")
  await page.waitForTimeout(400)
  await page.mouse.move(0, 0)
}

const shot = async (page: Page, name: string): Promise<void> => {
  await settle(page)
  await expect(page).toHaveScreenshot(`${name}.png`, {
    fullPage: true,
    mask: [
      page.locator('[data-testid^="card-"] .gap-1'),
      page.locator('[data-testid^="card-completed-"] p.text-xs'),
    ],
  })
}

test("the pages look the same", async ({ page }) => {
  await page.route(
    (url) => !["127.0.0.1", "localhost"].includes(url.hostname),
    (route) => route.abort(),
  )
  await page.goto("/")
  await expect(page.getByText("Welcome to Todo", { exact: true })).toBeVisible()
  await shot(page, "01-sign-in")
  await page.getByTestId("button-google-signin").click()
  await expect(page.getByTestId("alert-no-calendar")).toBeVisible()
  await shot(page, "02-main-without-calendar")
  await page.getByTestId("nav-settings").click()
  await expect(page.getByTestId("select-calendar")).toBeVisible()
  await shot(page, "03-settings-empty")
  await page.getByTestId("select-calendar").click()
  await page.getByRole("option", { name: "E2E Calendar (Primary)" }).click()
  await page.getByTestId("button-save-settings").click()
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId("select-calendar")).toBeVisible()
  await page.waitForTimeout(1000)
  await shot(page, "04-settings-saved")
  await page.getByTestId("nav-tasks").click()
  await expect(page.getByTestId("alert-no-calendar")).toHaveCount(0)
  await shot(page, "05-main-empty")
  for (const title of ["Visual one", "Visual two"]) {
    await page.getByTestId("input-task-title").fill(title)
    await page.getByTestId("textarea-task-details").fill(`Details of ${title}`)
    await page.getByTestId("button-create-task").click()
    await expect(page.getByText(title, { exact: true })).toBeVisible()
  }
  await page.waitForTimeout(6000)
  await shot(page, "06-main-tasks")
  const card = page.locator('[data-testid^="card-task-"]', { hasText: "Visual two" })
  await card.locator('button[role="checkbox"]').click()
  await expect(card).toHaveCount(0)
  await page.getByTestId("button-toggle-completed").click()
  await shot(page, "07-main-completed")
  await page.getByTestId("button-theme-toggle").click()
  await shot(page, "08-main-dark")
  await page.goto("/settings")
  await expect(page.getByTestId("select-calendar")).toBeVisible()
  await page.waitForTimeout(1000)
  await shot(page, "09-settings-dark")
  await page.getByTestId("button-theme-toggle").click()
  await page.goto("/privacy")
  await shot(page, "10-privacy")
  await page.goto("/tos")
  await shot(page, "11-tos")
  await page.goto("/no-such-page")
  await shot(page, "12-not-found")
  // A saved work start hour after a reload.
  await page.goto("/settings")
  const start = page.getByTestId("select-work-start")
  await start.focus()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("option", { name: "09:00", exact: true })).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await expect(page.getByRole("option", { name: "08:00", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")
  await page.getByTestId("button-save-settings").click()
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible()
  await page.reload()
  await expect(start).toBeVisible()
  await page.waitForTimeout(1000)
  await shot(page, "13-settings-hour-saved")
})
