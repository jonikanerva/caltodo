// The known axe defects of the task list (support.ts) for each list length
// and theme. Axe names an element with the shortest unique selector, so the
// selector of a drag handle or a checkbox changes with the number of tasks.
// The other specs share one account and leave a varying number of tasks, so
// these tests give the page a fixed list of their own.
import type { Page } from "@playwright/test"
import { expect, expectNoAxeViolations, test } from "./support.js"

// A valid `CalendarTask` list (contract/openapi.json) with `count` tasks. The
// ids are longer than the ids of the fake calendar, like Google event ids.
const taskList = (count: number): object[] =>
  Array.from({ length: count }, (_, index) => {
    const start = new Date(Date.UTC(2026, 9, 19, 9 + index))
    const end = new Date(start.getTime() + 60 * 60 * 1000)
    return {
      id: `known-defect-${String(index)}`,
      title: `Known defect task ${String(index)}`,
      details: null,
      duration: 60,
      scheduledStart: start.toISOString(),
      scheduledEnd: end.toISOString(),
      completed: false,
      completedAt: null,
      priority: index,
    }
  })

const showTasks = async (page: Page, count: number): Promise<void> => {
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue()
      return
    }
    await route.fulfill({ json: taskList(count) })
  })
  await page.goto("/")
  await expect(page.locator('[data-testid^="card-task-known-defect-"]')).toHaveCount(
    count,
  )
}

// Changes the theme and waits for the new theme class.
const toggleTheme = async (page: Page): Promise<void> => {
  const html = page.locator("html")
  const dark = await html.evaluate((element) => element.classList.contains("dark"))
  await page.getByTestId("button-theme-toggle").click()
  await expect
    .poll(() => html.evaluate((element) => element.classList.contains("dark")))
    .toBe(!dark)
}

for (const count of [1, 3]) {
  test(`the known defects of a ${String(count)}-task list pass in both themes`, async ({
    page,
  }) => {
    await showTasks(page, count)
    await expectNoAxeViolations(page)
    await toggleTheme(page)
    await expectNoAxeViolations(page)
  })
}

test("an unnamed command outside the drag handles is a violation", async ({ page }) => {
  await showTasks(page, 1)
  // An element with the role of the drag handle, but not a drag handle of
  // @hello-pangea/dnd, so it is not a known defect.
  await page.evaluate(() => {
    const form = document.querySelector("form")
    if (form === null) throw new Error("no form")
    const command = document.createElement("div")
    command.setAttribute("role", "button")
    command.tabIndex = 0
    form.append(command)
  })
  await expect(expectNoAxeViolations(page)).rejects.toThrow(/aria-command-name/)
})
