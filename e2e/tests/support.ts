// The shared fixture of every journey.
//
// - The browser never reaches the network: a request to another host than
//   the test server is aborted and fails the test, except the Google Fonts
//   stylesheet of `index.html`.
// - A `securitypolicyviolation` event, a console error about the
//   Content-Security-Policy, or an uncaught page error fails the test. One
//   violation is expected: the production CSP of the Node server
//   (`style-src 'self' 'unsafe-inline'`) blocks the Google Fonts stylesheet
//   that `index.html` links, so the deployed app has always shown the local
//   fallback fonts. The rewrite keeps both as they are (STACK.md §13).
import { AxeBuilder } from "@axe-core/playwright"
import { test as base, expect, type Page } from "@playwright/test"

export { expect }

const REPORT_BINDING = "__caltodoReportCspViolation"
const FONTS_ORIGIN = "https://fonts.googleapis.com"

interface Violation {
  readonly directive: string
  readonly blockedUri: string
  readonly sourceFile: string
}

const isLoopback = (url: URL): boolean =>
  url.hostname === "127.0.0.1" || url.hostname === "localhost"

// The known CSP violation of the unchanged page (see above): the stylesheet
// element (`style-src-elem`) and the stylesheet fetch of axe (`connect-src`).
const isKnownFontViolation = (violation: Violation): boolean =>
  violation.blockedUri.startsWith(FONTS_ORIGIN)

// The client address of each test. The server keeps its real rate limits
// (120 API requests per minute per client) and trusts one
// `X-Forwarded-For` hop, so each test sends its own address: the requests
// of one test never count against the limit of another test. The counter
// starts again in each worker process, and each project runs in a new worker,
// so the second octet holds the worker index. Without it, the tests of the
// second project reuse the addresses of the first project on the same server.
let clientCount = 0
const nextClientAddress = (workerIndex: number): string => {
  clientCount += 1
  return `10.${String(64 + (workerIndex % 192))}.${String(Math.floor(clientCount / 250))}.${String((clientCount % 250) + 1)}`
}

export const test = base.extend<{ problems: string[] }>({
  extraHTTPHeaders: async ({ extraHTTPHeaders }, use, testInfo) => {
    await use({
      ...extraHTTPHeaders,
      "X-Forwarded-For": nextClientAddress(testInfo.workerIndex),
    })
  },
  problems: [
    async ({ context }, use) => {
      const problems: string[] = []
      await context.exposeBinding(REPORT_BINDING, (_source, violation: Violation) => {
        if (!isKnownFontViolation(violation)) {
          problems.push(
            `CSP violation: ${violation.directive} blocked ${violation.blockedUri} (${violation.sourceFile})`,
          )
        }
      })
      await context.addInitScript((binding: string) => {
        document.addEventListener(
          "securitypolicyviolation",
          (event) => {
            const report: unknown = Reflect.get(window, binding)
            if (typeof report === "function") {
              void Reflect.apply(report, window, [
                {
                  directive: event.effectiveDirective,
                  blockedUri: event.blockedURI,
                  sourceFile: event.sourceFile,
                },
              ])
            }
          },
          { capture: true },
        )
      }, REPORT_BINDING)
      await context.route(
        (url) => !isLoopback(url),
        async (route) => {
          const url = new URL(route.request().url())
          if (url.origin !== FONTS_ORIGIN && url.origin !== "https://fonts.gstatic.com") {
            problems.push(`unexpected request: ${url.origin}${url.pathname}`)
          }
          await route.abort("blockedbyclient")
        },
      )
      context.on("console", (message) => {
        const text = message.text()
        if (
          message.type() === "error" &&
          /content security policy/i.test(text) &&
          !text.includes(FONTS_ORIGIN)
        ) {
          problems.push(`CSP console error: ${text}`)
        }
      })
      context.on("weberror", (error) => {
        problems.push(`page error: ${error.error().message}`)
      })
      await use(problems)
      expect(problems, "browser problems of the test").toEqual([])
    },
    { auto: true },
  ],
})

// The WCAG 2.2 A and AA rules of axe. `wcag22aa` adds the target size rule.
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]

// Accessibility defects of the unchanged UI and of the action pages of the
// Node server. This change must not alter what the user sees or the action
// page markup, so these defects are a scoped exception (STACK.md §13) and a
// follow-up item. Each entry names the rule and the elements it covers; a
// violation on any other element fails the test.
const KNOWN_DEFECTS: Record<string, RegExp> = {
  // `index.html` sets `maximum-scale=1`.
  "meta-viewport": /^meta\[name="viewport"\]$/,
  // The footer links differ from the text only by color.
  "link-in-text-block": /^(\.active|a\[href\$="(privacy|tos)"\])$/,
  // The drag handles of @hello-pangea/dnd have no accessible name.
  "aria-command-name": /^div\[data-rfd-drag-handle-draggable-id=/,
  // The task checkboxes, the duration select, and the toast close button.
  "button-name": /checkbox-complete-|^\.absolute$|placeholder|select-duration/,
  // The Google icon of the sign-in button.
  "svg-img-alt": /^\.h-4$/,
  // The action pages of the Node server have no `lang`.
  "html-has-lang": /^html$/,
}

// Known defects that axe names with a selector that changes with the page
// state. These entries match the markup of the element instead, and
// optionally also its selector.
interface MarkupDefect {
  readonly html: RegExp
  readonly target?: RegExp
}

const KNOWN_DEFECT_MARKUP: Record<string, readonly MarkupDefect[]> = {
  // The header navigation on a narrow screen hides the label text of its
  // buttons, so the buttons and their links have no accessible name.
  "button-name": [{ html: /^<button[^>]* data-testid="nav-(tasks|settings)"/ }],
  "link-name": [{ html: /^<a [^>]*href="\/(settings)?"/ }],
  // The contrast defects of the unchanged theme, element by element. A
  // contrast violation of any other element fails the test.
  "color-contrast": [
    // White text on the primary blue (3.48:1) and the destructive red
    // (3.62:1) buttons.
    {
      html: /^<button [^>]*data-testid="(button-google-signin|button-save-settings|button-delete-data)"/,
    },
    // The footer text and its links (`text-muted-foreground/70`, 2.71:1).
    {
      html: /^<p class="text-center text-xs text-muted-foreground\/70">Copyright donut /,
    },
    { html: /^<a class="hover:text-muted-foreground( active)?" href="\/(privacy|tos)"/ },
    // The time and the duration badges of a task card.
    {
      html: /^<div class="whitespace-nowrap inline-flex items-center rounded-md [^"]*(\[border-color:var\(--badge-outline\)\] shadow-xs gap-1 text-xs|border-transparent bg-secondary text-secondary-foreground gap-1)"/,
      target: /^div\[data-rfd-draggable-id=/,
    },
  ],
}

const isKnownDefect = (rule: string, target: string, html: string): boolean =>
  (KNOWN_DEFECTS[rule]?.test(target) ?? false) ||
  (KNOWN_DEFECT_MARKUP[rule]?.some(
    (defect) => defect.html.test(html) && (defect.target?.test(target) ?? true),
  ) ??
    false)

// Fails on any axe violation of the page as it is now, except the known
// defects above. Call it only after an assertion on the content of the state.
export const expectNoAxeViolations = async (page: Page): Promise<void> => {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const violations = results.violations
    .map((violation) => ({
      rule: violation.id,
      impact: violation.impact,
      targets: violation.nodes
        .filter((node) => !isKnownDefect(violation.id, node.target.join(" "), node.html))
        .map((node) => node.target.join(" ")),
    }))
    .filter((violation) => violation.targets.length > 0)
  expect(violations, `axe violations on ${page.url()}`).toEqual([])
}

// Signs in through the fake Google sign-in of the test server.
export const signIn = async (page: Page): Promise<void> => {
  await page.goto("/")
  await page.getByTestId("button-google-signin").click()
  await expect(page.getByTestId("nav-tasks")).toBeVisible()
}

// Chooses an hour in a work-hour select with the keyboard: the Radix list
// scrolls while it opens, so a pointer click on an option is not stable.
// The open list focuses the current hour; the arrows move one hour.
export const chooseHour = async (
  page: Page,
  testId: string,
  hour: string,
): Promise<void> => {
  const trigger = page.getByTestId(testId)
  const current = Number.parseInt((await trigger.textContent()) ?? "0", 10)
  const target = Number.parseInt(hour, 10)
  await trigger.focus()
  await page.keyboard.press("Enter")
  const label = (value: number): string => `${String(value).padStart(2, "0")}:00`
  await expect(
    page.getByRole("option", { name: label(current), exact: true }),
  ).toBeFocused()
  const key = target > current ? "ArrowDown" : "ArrowUp"
  for (let step = 1; step <= Math.abs(target - current); step += 1) {
    await page.keyboard.press(key)
    const next = target > current ? current + step : current - step
    await expect(
      page.getByRole("option", { name: label(next), exact: true }),
    ).toBeFocused()
  }
  await page.keyboard.press("Enter")
  await expect(trigger).toContainText(`${hour}:00`)
}

// Saves settings through the API with the CSRF token of the session.
export const saveSettings = async (
  page: Page,
  settings: { workStartHour: number; workEndHour: number },
): Promise<void> => {
  const user = await page.request.get("/api/auth/user")
  const { csrfToken } = (await user.json()) as { csrfToken: string }
  const saved = await page.request.patch("/api/settings", {
    headers: { "X-CSRF-Token": csrfToken },
    data: {
      calendarId: "primary",
      timezone: "America/New_York",
      defaultDuration: 60,
      eventColor: "1",
      ...settings,
    },
  })
  expect(saved.ok()).toBe(true)
}
