// The task list when the server cannot read the tasks: the page shows an
// error, never an empty or an old list (issue #5, item 7). The browser gets
// the answer of the server when Google Calendar fails. A real Google failure
// in the e2e server would affect the other journeys of the shared account.
import type { Page, Route } from "@playwright/test"
import { expect, expectNoAxeViolations, test } from "./support.js"

const EMPTY_LIST = "No tasks yet. Create one above to get started!"

const googleUnavailable = (route: Route): Promise<void> =>
  route.fulfill({
    status: 502,
    contentType: "application/problem+json",
    body: JSON.stringify({
      type: "about:blank",
      title: "Bad Gateway",
      status: 502,
      detail: "Google Calendar is unavailable. Try again later.",
      code: "google_unavailable",
    }),
  })

// Answers each GET of the task list with the next handler; the last handler
// answers every later GET.
const answerTaskList = async (
  page: Page,
  ...handlers: ((route: Route) => Promise<void>)[]
): Promise<void> => {
  let count = 0
  await page.route("**/api/tasks", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback()
      return
    }
    const handler = handlers[Math.min(count, handlers.length - 1)]
    count += 1
    await handler?.(route)
  })
}

const expectErrorInsteadOfList = async (page: Page): Promise<void> => {
  const alert = page.getByTestId("alert-tasks-error")
  await expect(alert).toBeVisible()
  await expect(alert).toHaveAttribute("role", "alert")
  await expect(alert).toContainText("Could not load tasks")
  await expect(alert).toContainText("Failed to load tasks. Reload the page to try again.")
  await expect(page.getByText(EMPTY_LIST)).toHaveCount(0)
  await expect(page.locator('[data-testid^="card-task-"]')).toHaveCount(0)
  await expect(page.getByTestId("button-toggle-completed")).toHaveCount(0)
  await expect(page.getByTestId("button-reload-calendar")).toHaveCount(0)
}

test("a failed task load shows an error instead of an empty list", async ({ page }) => {
  await answerTaskList(page, googleUnavailable)
  await page.goto("/")
  // `exact` keeps the alert title "Could not load tasks" out of the match.
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible()
  await expectErrorInsteadOfList(page)
  await expectNoAxeViolations(page)
  // The alert keeps the text contrast in the other theme too.
  await page.getByTestId("button-theme-toggle").click()
  await expectNoAxeViolations(page)
})

test("a failed reload hides the old list", async ({ page }) => {
  const open = {
    id: "e2eerroropen",
    title: "Open task before the failure",
    details: null,
    duration: 60,
    scheduledStart: "2030-03-04T10:00:00.000Z",
    scheduledEnd: "2030-03-04T11:00:00.000Z",
    completed: false,
    completedAt: null,
    priority: 1,
  }
  const done = {
    ...open,
    id: "e2eerrordone",
    title: "Completed task before the failure",
    completed: true,
    completedAt: "2030-03-01T10:00:00.000Z",
    priority: 0,
  }
  // The Reload button needs a selected calendar. The other journeys share the
  // account, so the test answers the settings itself.
  await page.route("**/api/settings", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "e2eerrorsettings",
        userId: "e2eerroruser",
        calendarId: "primary",
        workStartHour: 9,
        workEndHour: 17,
        timezone: "Europe/Helsinki",
        defaultDuration: 60,
        eventColor: "1",
      }),
    })
  })
  await page.route("**/api/tasks/reload", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    }),
  )
  await answerTaskList(
    page,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([open, done]),
      }),
    googleUnavailable,
  )
  await page.goto("/")
  await expect(page.getByTestId(`card-task-${open.id}`)).toBeVisible()
  await expect(page.getByTestId("button-toggle-completed")).toBeVisible()
  await page.getByTestId("button-reload-calendar").click()
  await expectErrorInsteadOfList(page)
})

test("a successful empty load still shows the empty list", async ({ page }) => {
  await answerTaskList(page, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  )
  await page.goto("/")
  await expect(page.getByText(EMPTY_LIST)).toBeVisible()
  await expect(page.getByTestId("alert-tasks-error")).toHaveCount(0)
})
