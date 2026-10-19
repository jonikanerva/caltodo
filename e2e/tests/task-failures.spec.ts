// The failures of task writes that the user must see (issue #5, items 4 and
// 5). The browser gets the answers of the server for these failures. The
// server side of each failure has its own integration test
// (`crates/server/tests/integration/api_tasks.rs`). Real failures in the e2e
// server would affect the other journeys of the shared account, so each test
// answers the task routes itself.
import type { Page, Route } from "@playwright/test"
import { expect, test } from "./support.js"

const task = (
  id: string,
  title: string,
  hour: string,
  nextHour: string,
  priority: number,
) => ({
  id,
  title,
  details: null,
  duration: 60,
  scheduledStart: `2030-03-04T${hour}:00:00.000Z`,
  scheduledEnd: `2030-03-04T${nextHour}:00:00.000Z`,
  completed: false,
  completedAt: null,
  priority,
})

const first = task("e2efailfirst", "First task of the failure test", "09", "10", 0)
const second = task("e2efailsecond", "Second task of the failure test", "10", "11", 1)

const json = (route: Route, body: unknown, status = 200): Promise<void> =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })

// A selected calendar, so the page shows the list and the create form.
const answerSettings = async (page: Page): Promise<void> => {
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback()
      return
    }
    await json(route, {
      id: "e2efailsettings",
      userId: "e2efailuser",
      calendarId: "primary",
      workStartHour: 9,
      workEndHour: 17,
      timezone: "Europe/Helsinki",
      defaultDuration: 60,
      eventColor: "1",
    })
  })
}

// Answers each GET of the task list with `tasks` and counts the GETs.
const answerTaskList = async (
  page: Page,
  tasks: () => unknown[],
): Promise<{ count: () => number }> => {
  let count = 0
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback()
      return
    }
    count += 1
    await json(route, tasks())
  })
  return { count: () => count }
}

test("a failed reorder reloads the list and shows an error", async ({ page }) => {
  await answerSettings(page)
  const list = await answerTaskList(page, () => [first, second])
  await page.route("**/api/tasks/reorder", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/problem+json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: "Task not found",
        code: "task_not_found",
      }),
    }),
  )
  await page.goto("/")
  const titles = page.locator('[data-testid^="card-task-"] span.font-medium')
  await expect(titles).toHaveText([first.title, second.title])
  const loads = list.count()
  // @hello-pangea/dnd: Space lifts, an arrow moves, Space drops.
  await page
    .getByTestId(`card-task-${first.id}`)
    .locator("[data-rfd-drag-handle-draggable-id]")
    .focus()
  await page.keyboard.press("Space")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Space")
  await expect(
    page.getByText("Failed to reorder tasks. Please try again.", { exact: true }),
  ).toBeVisible()
  // The page reads the list again and shows the order of the server.
  await expect.poll(list.count).toBeGreaterThan(loads)
  await expect(titles).toHaveText([first.title, second.title])
})

test("an urgent task that did not move shows a warning", async ({ page }) => {
  await answerSettings(page)
  let created = false
  await answerTaskList(page, () => (created ? [first, second] : [first]))
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    created = true
    await json(route, { ...second, urgentMoveFailed: true })
  })
  await page.goto("/")
  await expect(page.getByTestId(`card-task-${first.id}`)).toBeVisible()
  await page.getByTestId("input-task-title").fill(second.title)
  await page.getByTestId("checkbox-urgent").click()
  await page.getByTestId("button-create-task").click()
  await expect(
    page.getByText(
      "Your task has been scheduled, but other tasks could not be moved after it.",
      { exact: true },
    ),
  ).toBeVisible()
  await expect(
    page.getByText("Your task has been scheduled in your calendar", { exact: true }),
  ).toHaveCount(0)
  // The task exists, so the form clears and the list shows the task.
  await expect(page.getByTestId("input-task-title")).toHaveValue("")
  await expect(page.getByTestId(`card-task-${second.id}`)).toBeVisible()
})
