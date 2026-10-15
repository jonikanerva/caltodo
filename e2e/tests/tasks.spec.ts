// The task journeys: create, complete, redo, reorder, and the buttons of the
// list. The settings journey configured the calendar before.
import type { Page } from "@playwright/test"
import { expect, expectNoAxeViolations, saveSettings, test } from "./support.js"

const unique = (label: string): string =>
  `${label} ${String(Date.now())}-${String(Math.floor(Math.random() * 1000))}`

const createTask = async (page: Page, title: string, details = ""): Promise<void> => {
  await page.getByTestId("input-task-title").fill(title)
  if (details !== "") {
    await page.getByTestId("textarea-task-details").fill(details)
  }
  await page.getByTestId("button-create-task").click()
  await expect(
    page.getByText("Your task has been scheduled in your calendar", { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(title, { exact: true })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible()
  await expect(page.getByTestId("alert-no-calendar")).toHaveCount(0)
})

test("creates a task with details", async ({ page }) => {
  const title = unique("Water the plants")
  await createTask(page, title, "Use the green can")
  await expect(page.getByText("Use the green can").first()).toBeVisible()
  await expectNoAxeViolations(page)
})

test("completes a task and reopens it", async ({ page }) => {
  const title = unique("Pay the bills")
  await createTask(page, title)
  const card = page.locator('[data-testid^="card-task-"]', { hasText: title })
  const id = (await card.getAttribute("data-testid"))?.replace("card-task-", "") ?? ""
  await page.getByTestId(`checkbox-complete-${id}`).click()
  await expect(card).toHaveCount(0)
  await page.getByTestId("button-toggle-completed").click()
  const completed = page.getByTestId(`card-completed-${id}`)
  await expect(completed).toContainText(title)
  await expect(completed).toContainText("Completed")
  await page.getByTestId(`button-redo-${id}`).click()
  await expect(page.getByTestId(`card-task-${id}`)).toBeVisible()
})

test("reorders two tasks with the keyboard", async ({ page }) => {
  const first = unique("First task")
  await createTask(page, first)
  await createTask(page, unique("Second task"))
  const titles = page.locator('[data-testid^="card-task-"] span.font-medium')
  const before = await titles.allTextContents()
  const firstIndex = before.indexOf(first)
  // The task after the first task in the list. The second task gets a later
  // slot, so this task exists. It is not always the second task: the other
  // journeys leave tasks of other durations in the same account, and the
  // free-slot search can put the second task after them.
  const next = before[firstIndex + 1]
  if (next === undefined) throw new Error("no task after the first task")
  // @hello-pangea/dnd: Space lifts, an arrow moves, Space drops.
  const handle = page
    .locator('[data-testid^="card-task-"]', { hasText: first })
    .locator("[data-rfd-drag-handle-draggable-id]")
  await handle.focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Space")
  await expect
    .poll(async () => {
      const after = await titles.allTextContents()
      return [after.indexOf(next), after.indexOf(first)]
    })
    .toEqual([firstIndex, firstIndex + 1])
})

test("reloads and reschedules the list", async ({ page }) => {
  await createTask(page, unique("Plan the week"))
  await page.getByTestId("button-reload-calendar").click()
  await expect(page.getByText("Calendar synced", { exact: true })).toBeVisible()
  await page.getByTestId("button-reschedule-all").click()
  await expect(page.getByText("Tasks rescheduled", { exact: true })).toBeVisible()
})

test("shows the no-slot message of the server", async ({ page }) => {
  // Work hours that end before they start leave no free slot.
  await saveSettings(page, { workStartHour: 17, workEndHour: 9 })
  await page.goto("/")
  await page.getByTestId("input-task-title").fill(unique("No room"))
  await page.getByTestId("button-create-task").click()
  await expect(
    page.getByText("No free time slots available in the next 90 days.", { exact: true }),
  ).toBeVisible()
  await saveSettings(page, { workStartHour: 9, workEndHour: 17 })
})
