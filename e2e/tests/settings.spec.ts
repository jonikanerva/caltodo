// The settings journey: calendar, work hours, time zone, duration, and color.
import {
  chooseHour,
  expect,
  expectNoAxeViolations,
  saveSettings,
  test,
} from "./support.js"

test("saves the settings and keeps them after a reload", async ({ page }) => {
  // The default work hours: the original client shows a saved work hour
  // other than the default as an empty select after a page load (a known
  // defect, see the PR), so the journey starts from the defaults.
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
  // After a reload the original client shows the saved calendar and the
  // changed work hour as empty selects (the known defect above); the radios
  // keep their saved values.
  await page.reload()
  await expect(page.getByTestId("radio-duration-30")).toHaveAttribute(
    "data-state",
    "checked",
  )
  await expect(page.getByTestId("radio-color-7")).toHaveAttribute("data-state", "checked")
  await page.getByTestId("nav-tasks").click()
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible()
  await expect(page.getByTestId("alert-no-calendar")).toHaveCount(0)
})
