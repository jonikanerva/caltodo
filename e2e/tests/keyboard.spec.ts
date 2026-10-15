// The main flow with the keyboard alone, with a visible focus on each stop.
import type { Page } from "@playwright/test"
import { expect, test } from "./support.js"

// True when the focused element shows a focus indicator: an outline or the
// ring (box-shadow) of the UI components.
const focusIsVisible = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const element = document.activeElement
    if (element === null || element === document.body) return false
    const style = getComputedStyle(element)
    const outline =
      style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0
    return outline || style.boxShadow !== "none"
  })

// The time that the settings answer waits in the slow-settings journey. The
// keyboard steps of the journey take less time, so without the wait for the
// enabled button the focus skips the button.
const SETTINGS_DELAY_MS = 1_000

const createTaskWithKeyboard = async (page: Page): Promise<void> => {
  await page.goto("/")
  const title = page.getByTestId("input-task-title")
  await expect(title).toBeFocused()
  const name = `Keyboard task ${String(Date.now())}`
  await page.keyboard.type(name)
  // The Create Task button stays disabled until `GET /api/settings` answers
  // with a calendar, and a disabled button is not a tab stop. A user who
  // tabs before the answer skips the button; the journey waits for the state
  // that the user sees.
  await expect(page.getByTestId("button-create-task")).toBeEnabled()
  await page.keyboard.press("Tab")
  await expect(page.getByTestId("textarea-task-details")).toBeFocused()
  expect(await focusIsVisible(page)).toBe(true)
  await page.keyboard.type("Typed details")
  await page.keyboard.press("Tab")
  await expect(page.getByTestId("checkbox-urgent")).toBeFocused()
  expect(await focusIsVisible(page)).toBe(true)
  await page.keyboard.press("Tab")
  await expect(page.getByTestId("select-duration")).toBeFocused()
  expect(await focusIsVisible(page)).toBe(true)
  await page.keyboard.press("Tab")
  await expect(page.getByTestId("button-create-task")).toBeFocused()
  expect(await focusIsVisible(page)).toBe(true)
  await page.keyboard.press("Enter")
  await expect(page.getByText(name, { exact: true })).toBeVisible()
}

test("creates a task with the keyboard alone", async ({ page }) => {
  await createTaskWithKeyboard(page)
})

test("creates a task with the keyboard alone when the settings answer late", async ({
  page,
}) => {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() === "GET") {
      await new Promise((resolve) => setTimeout(resolve, SETTINGS_DELAY_MS))
    }
    await route.continue()
  })
  await createTaskWithKeyboard(page)
})

test("reaches the header controls with the keyboard", async ({ page }) => {
  await page.goto("/settings")
  await expect(
    page.getByText("Configure your calendar preferences and work hours"),
  ).toBeVisible()
  await page.keyboard.press("Tab")
  for (let step = 0; step < 10; step += 1) {
    const focused = await page.evaluate(() =>
      document.activeElement?.getAttribute("data-testid"),
    )
    if (focused === "nav-tasks") break
    await page.keyboard.press("Tab")
  }
  await expect(page.getByTestId("nav-tasks")).toBeFocused()
  expect(await focusIsVisible(page)).toBe(true)
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/$/)
})
