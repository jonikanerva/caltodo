// The action link of a task event: the page that a user opens from Google
// Calendar, signed in and signed out.
import type { Page } from "@playwright/test"
import { BASE_URL } from "./servers.js"
import { expect, expectNoAxeViolations, test } from "./support.js"

const createTaskWithLink = async (
  page: Page,
): Promise<{ title: string; link: string }> => {
  const title = `Linked task ${String(Date.now())}`
  await page.goto("/")
  await page.getByTestId("input-task-title").fill(title)
  await page.getByTestId("button-create-task").click()
  await expect(page.getByText(title, { exact: true })).toBeVisible()
  const response = await page.request.get(
    `/__e2e/action-link?title=${encodeURIComponent(title)}`,
  )
  expect(response.ok()).toBe(true)
  const link = await response.text()
  expect(link.startsWith(`${BASE_URL}/action/`)).toBe(true)
  return { title, link }
}

test("the manage page completes the task", async ({ page }) => {
  const { title, link } = await createTaskWithLink(page)
  await page.goto(link)
  await expect(page.getByRole("heading", { name: "Manage task" })).toBeVisible()
  await expect(page.getByText(`"${title}"`)).toBeVisible()
  await expectNoAxeViolations(page)
  await page.getByRole("button", { name: "Mark complete" }).click()
  // The Node server answered this way too: the new link of the event retires
  // the used link before the answer (see the PR, "parity quirks").
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible()
  await expect(page.getByText("Invalid or expired link.")).toBeVisible()
  await page.getByRole("link", { name: "Go to Todo" }).click()
  await page.getByTestId("button-toggle-completed").click()
  await expect(
    page.locator('[data-testid^="card-completed-"]', { hasText: title }),
  ).toBeVisible()
})

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test("the link asks for a sign-in and returns to the task", async ({
    browser,
    page,
  }) => {
    const owner = await browser.newContext({
      storageState: "test-results/.auth/state.json",
    })
    const ownerPage = await owner.newPage()
    const { title, link } = await createTaskWithLink(ownerPage)
    await owner.close()

    await page.goto(link)
    await expect(page.getByRole("heading", { name: "Sign in required" })).toBeVisible()
    await expectNoAxeViolations(page)
    await page.getByRole("link", { name: "Sign in with Google" }).click()
    await expect(page).toHaveURL(link)
    await expect(page.getByRole("heading", { name: "Manage task" })).toBeVisible()
    await expect(page.getByText(`"${title}"`)).toBeVisible()
  })
})
