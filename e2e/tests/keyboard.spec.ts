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

test("creates a task with the keyboard alone", async ({ page }) => {
  await page.goto("/")
  const title = page.getByTestId("input-task-title")
  await expect(title).toBeFocused()
  const name = `Keyboard task ${String(Date.now())}`
  await page.keyboard.type(name)
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
