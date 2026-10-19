import { describe, expect, it, vi } from "vitest"
import { ApiError, createApi, problemStatus, type ProblemCode } from "../index"
import { zProblemCode } from "../generated/zod.gen"

// The facade against a fake `fetch`. Each test builds the response that the
// server, or an intermediary, could send, and checks what the web app gets.

const BASE = "http://api.test"

const task = {
  id: "evt-1",
  title: "Write tests",
  details: null,
  duration: 30,
  scheduledStart: "2026-03-02T09:00:00.000Z",
  scheduledEnd: "2026-03-02T09:30:00.000Z",
  completed: false,
  completedAt: null,
  priority: 0,
}

const user = {
  id: "user-1",
  googleId: "google-1",
  email: "user@example.com",
  displayName: "User",
  csrfToken: "csrf-from-auth",
}

const json = (body: unknown, status = 200, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } })

const problemBody = (code: ProblemCode, detail = "A fixed text.") => ({
  type: "about:blank",
  title: "Title",
  status: problemStatus(code),
  detail,
  code,
})

const problem = (code: ProblemCode, detail?: string) =>
  json(problemBody(code, detail), problemStatus(code), "application/problem+json")

const setup = (respond: (request: Request) => Response | Promise<Response>) => {
  const requests: Request[] = []
  const fetch = vi.fn((input: RequestInfo | URL) => {
    if (!(input instanceof Request)) {
      throw new TypeError("the client sends a Request")
    }
    requests.push(input)
    return Promise.resolve(respond(input))
  })
  return { api: createApi({ baseUrl: () => BASE, fetch }), requests }
}

const failure = async (pending: Promise<unknown>): Promise<unknown> => {
  try {
    await pending
  } catch (error) {
    return error
  }
  throw new Error("the call did not fail")
}

const apiError = async (pending: Promise<unknown>): Promise<ApiError> => {
  const error = await failure(pending)
  expect(error).toBeInstanceOf(ApiError)
  if (!(error instanceof ApiError)) throw new Error("not an ApiError")
  return error
}

describe("success bodies", () => {
  it("returns a valid task list from the same origin with the cookie", async () => {
    const { api, requests } = setup(() => json([task]))
    await expect(api.fetchTasks()).resolves.toEqual([task])
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${BASE}/api/tasks`])
    expect(requests[0]?.credentials).toBe("same-origin")
  })

  it("accepts null settings", async () => {
    const { api } = setup(() => json(null))
    await expect(api.fetchSettings()).resolves.toBeNull()
  })

  it("rejects a success body that breaks the contract", async () => {
    for (const body of [
      [{ ...task, title: undefined }],
      [{ ...task, duration: "30" }],
      [{ ...task, priority: -1 }],
      [{ ...task, completedAt: 5 }],
      [{ ...task, details: undefined }],
      { tasks: [task] },
    ]) {
      const { api } = setup(() => json(body))
      const error = await apiError(api.fetchTasks())
      expect(error.status).toBe(200)
      expect(error.code).toBe("invalid_response")
    }
  })

  it("returns the created task with the urgent move result", async () => {
    for (const urgentMoveFailed of [false, true]) {
      const { api } = setup(() => json({ task, urgentMoveFailed }))
      await expect(api.createTask({ title: "T", urgent: true })).resolves.toEqual({
        task,
        urgentMoveFailed,
      })
    }
  })

  it("rejects a create answer without the urgent move result", async () => {
    // The answer of the server before issue #5 item 4: the bare task.
    for (const body of [task, { task }, { task, urgentMoveFailed: "no" }]) {
      const { api } = setup(() => json(body))
      const error = await apiError(api.createTask({ title: "T" }))
      expect(error.code).toBe("invalid_response")
    }
  })

  it("rejects a success answer that is not JSON", async () => {
    const { api } = setup(() => new Response("<html></html>", { status: 200 }))
    const error = await apiError(api.fetchCalendars())
    expect(error.code).toBe("invalid_response")
  })

  it("rejects an empty success answer", async () => {
    const { api } = setup(() => new Response(null, { status: 204 }))
    const error = await apiError(api.reloadTasks())
    expect(error.code).toBe("invalid_response")
  })
})

describe("error bodies", () => {
  it("maps every known problem to its code and detail", async () => {
    for (const code of zProblemCode.options) {
      const { api } = setup(() => problem(code, `detail of ${code}`))
      const error = await apiError(api.fetchTasks())
      expect(error.status).toBe(problemStatus(code))
      expect(error.code).toBe(code)
      expect(error.detail).toBe(`detail of ${code}`)
      expect(error.message).toBe(`${String(problemStatus(code))}: detail of ${code}`)
    }
  })

  it("keeps the no-slot text in the message for the create form", async () => {
    const text = "No free time slots available in the next 90 days."
    const { api } = setup(() => problem("no_free_slot", text))
    const error = await failure(api.createTask({ title: "T" }))
    expect(error instanceof Error && error.message.includes(text)).toBe(true)
  })

  it("rejects a reorder with a missing task or a Google failure", async () => {
    for (const code of ["task_not_found", "google_unavailable"] as const) {
      const { api } = setup(() => problem(code))
      const error = await apiError(api.reorderTasks(["a", "b"]))
      expect(error.status).toBe(problemStatus(code))
      expect(error.code).toBe(code)
    }
  })

  it("does not trust an invalid or unknown error body", async () => {
    for (const response of [
      json(
        { ...problemBody("task_not_found"), code: "unknown_code" },
        404,
        "application/problem+json",
      ),
      json({ error: "Task not found" }, 404),
      json(problemBody("task_not_found"), 500, "application/problem+json"),
      json(
        { ...problemBody("task_not_found"), detail: 7 },
        404,
        "application/problem+json",
      ),
      new Response("<html>Bad gateway</html>", { status: 502 }),
    ]) {
      const { api } = setup(() => response.clone())
      const error = await apiError(api.fetchTasks())
      expect(error.code).toBe("unrecognized_error")
      expect(error.status).toBe(response.status)
      expect(error.detail).toBeUndefined()
    }
  })

  it("keeps a network failure as it is", async () => {
    const broken = new TypeError("network down")
    const { api } = setup(() => {
      throw broken
    })
    await expect(failure(api.fetchTasks())).resolves.toBe(broken)
  })
})

describe("session and CSRF", () => {
  it("returns null for an unauthenticated user", async () => {
    const { api } = setup(() => problem("unauthenticated"))
    await expect(api.fetchCurrentUser()).resolves.toBeNull()
    expect(api.getCsrfToken()).toBeUndefined()
  })

  it("fails on another error of the user route", async () => {
    const { api } = setup(() => problem("internal_error"))
    const error = await apiError(api.fetchCurrentUser())
    expect(error.code).toBe("internal_error")
  })

  it("stores the CSRF token of the user and sends it on writes only", async () => {
    const { api, requests } = setup((request) => {
      if (request.url.endsWith("/api/auth/user")) return json(user)
      if (request.url.endsWith("/api/tasks") && request.method === "GET") return json([])
      if (request.url.endsWith("/api/tasks"))
        return json({ task, urgentMoveFailed: false })
      return json(task)
    })
    await expect(api.fetchCurrentUser()).resolves.toEqual(user)
    expect(api.getCsrfToken()).toBe("csrf-from-auth")
    await api.fetchTasks()
    await api.createTask({ title: "Write tests", details: "", urgent: false })
    await api.updateTask("evt-1", true)
    const [, list, create, update] = requests
    expect(list?.headers.get("x-csrf-token")).toBeNull()
    expect(create?.headers.get("x-csrf-token")).toBe("csrf-from-auth")
    expect(create?.headers.get("content-type")).toBe("application/json")
    expect(await create?.json()).toEqual({
      title: "Write tests",
      details: "",
      urgent: false,
    })
    expect(update?.method).toBe("PATCH")
    expect(update?.url).toBe(`${BASE}/api/tasks/evt-1`)
    expect(await update?.json()).toEqual({ completed: true })
  })

  it("sends the documented bodies of the other writes", async () => {
    const { api, requests } = setup((request) => {
      if (request.url.endsWith("/reschedule-all")) {
        return json({
          success: true,
          summary: {
            moved: 1,
            unchanged: 0,
            skippedNoSlot: 0,
            skippedInvalid: 0,
            failed: 0,
          },
        })
      }
      if (request.url.endsWith("/api/settings")) {
        return json({
          id: "s",
          userId: "u",
          calendarId: "primary",
          workStartHour: 9,
          workEndHour: 17,
          timezone: "UTC",
          defaultDuration: 60,
          eventColor: "1",
        })
      }
      return json({ success: true })
    })
    api.setCsrfToken("t")
    await api.reorderTasks(["a", "b"])
    await api.rescheduleAllTasks()
    await api.reloadTasks()
    await api.updateSettings({
      workStartHour: 9,
      workEndHour: 17,
      timezone: "UTC",
      defaultDuration: 60,
      eventColor: "1",
    })
    await api.deleteAccount()
    await api.logout()
    expect(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      "POST /api/tasks/reorder",
      "POST /api/tasks/reschedule-all",
      "POST /api/tasks/reload",
      "PATCH /api/settings",
      "DELETE /api/account",
      "POST /api/auth/logout",
    ])
    expect(await requests[0]?.json()).toEqual({ taskIds: ["a", "b"] })
    for (const request of requests) {
      expect(request.headers.get("x-csrf-token")).toBe("t")
    }
  })
})
