// The public pages, the not-found page, and the navigation.
import { expect, expectNoAxeViolations, test } from "./support.js"

test("the privacy and terms pages need no sign-in", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
  const page = await context.newPage()
  await page.goto("/privacy")
  await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible()
  await expectNoAxeViolations(page)
  await page.getByRole("link", { name: "TOS" }).click()
  await expect(page).toHaveURL(/\/tos$/)
  await expectNoAxeViolations(page)
  await context.close()
})

test("an unknown path shows the not-found page", async ({ page }) => {
  await page.goto("/no-such-page")
  await expect(page.getByRole("heading", { name: "404 Page Not Found" })).toBeVisible()
})

test("the header navigates and toggles the theme", async ({ page }) => {
  await page.goto("/")
  await page.getByTestId("nav-settings").click()
  await expect(page).toHaveURL(/\/settings$/)
  await page.getByTestId("nav-tasks").click()
  await expect(page).toHaveURL(/\/$/)
  const html = page.locator("html")
  const dark = await html.evaluate((element) => element.classList.contains("dark"))
  await page.getByTestId("button-theme-toggle").click()
  await expect
    .poll(() => html.evaluate((element) => element.classList.contains("dark")))
    .toBe(!dark)
  await expectNoAxeViolations(page)
})

// The app font loads from the app origin (issue #5, item 15). The old Google
// Fonts stylesheet was blocked by the CSP, so the page showed a fallback font.
test("the page uses the Inter font from the app origin", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible()
  const font = await page.evaluate(async () => {
    await document.fonts.ready
    // `document.fonts.check()` is true when no face matches, so check the
    // loaded faces and the font files instead.
    const faces = [...document.fonts]
      .filter((face) => face.family.replaceAll('"', "") === "Inter Variable")
      .map((face) => face.status)
    const files = performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name))
      .filter((url) => url.pathname.endsWith(".woff2"))
      .map((url) => url.origin)
    return {
      body: getComputedStyle(document.body).fontFamily,
      faces,
      files,
      origin: location.origin,
    }
  })
  expect(font.body.startsWith('"Inter Variable"')).toBe(true)
  expect(font.faces).toContain("loaded")
  expect(font.files.length).toBeGreaterThan(0)
  expect(font.files.every((origin) => origin === font.origin)).toBe(true)
})
