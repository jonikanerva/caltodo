// The settings journey: calendar, work hours, time zone, duration, and color.
import {
  chooseHour,
  expect,
  expectNoAxeViolations,
  saveSettings,
  test,
} from "./support.js"

test("saves the settings and keeps them after a reload", async ({ page }) => {
  // The journey starts from the default work hours, so the hour select moves
  // from a known value.
  await saveSettings(page, { workStartHour: 9, workEndHour: 17 })
  await page.goto("/settings")
  await expect(
    page.getByText("Configure your calendar preferences and work hours"),
  ).toBeVisible()
  await expectNoAxeViolations(page)

  await page.getByTestId("select-calendar").click()
  await page.getByRole("option", { name: "E2E Calendar (Primary)" }).click()
  await chooseHour(page, "select-work-start", "08")
  await page.getByTestId("radio-duration-30").click()
  // The color radio is visually hidden; its round label is the control.
  await page.locator('label[for="color-7"]').click()
  await page.getByTestId("button-save-settings").click()
  await expect(page.getByText("Settings saved", { exact: true })).toBeVisible()

  const saved = await page.request.get("/api/settings")
  expect(await saved.json()).toMatchObject({
    calendarId: "primary",
    workStartHour: 8,
    defaultDuration: 30,
    eventColor: "7",
  })
  // After a reload the page shows every saved value. Before Radix Select
  // 2.4, the calendar and the changed work hour showed as empty selects.
  await page.reload()
  await expect(page.getByTestId("select-calendar")).toContainText(
    "E2E Calendar (Primary)",
  )
  await expect(page.getByTestId("select-work-start")).toContainText("08:00")
  await expect(page.getByTestId("radio-duration-30")).toHaveAttribute(
    "data-state",
    "checked",
  )
  await expect(page.getByTestId("radio-color-7")).toHaveAttribute("data-state", "checked")
  await page.getByTestId("nav-tasks").click()
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible()
  await expect(page.getByTestId("alert-no-calendar")).toHaveCount(0)
})
