// Writes crates/server/tests/fixtures/node/action_flow.golden.json: the
// outcome of `POST /api/action/:token` with the real Node modules
// (server/handlers/actionRoutes.ts, server/tokens.ts, server/calendar.ts).
//
// Only the database and googleapis are fakes. The fake storage keeps the
// action tokens in memory with the semantics of the SQL in
// server/storage.ts, so the token lifecycle runs as in production.
import { mkdirSync, writeFileSync } from "fs"
import path from "path"
import { describe, it, vi } from "vitest"

type TokenRow = {
  id: string
  tokenHash: string
  userId: string
  eventId: string
  calendarId: string
  expiresAt: Date
  usedAt: Date | null
}

const state = vi.hoisted(() => {
  Object.assign(process.env, {
    TOKEN_ENCRYPTION_KEY: "fixture-token-encryption-key-0123456789abcdef",
    ACTION_TOKEN_SECRET: "fixture-action-token-secret-0123456789abcdef",
    SESSION_SECRET: "fixture-session-secret-0123456789abcdef-xyz",
    DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused",
  })
  return {
    tokens: [] as TokenRow[],
    event: {} as Record<string, unknown>,
    patches: [] as unknown[],
  }
})

vi.mock("../../server/storage", () => ({
  storage: {
    getUser: async () => ({
      id: "user-1",
      accessToken: "access",
      refreshToken: "refresh",
    }),
    updateUser: async () => undefined,
    getUserSettings: async () => ({
      id: "s1",
      userId: "user-1",
      calendarId: "primary",
      timezone: "UTC",
      workStartHour: 9,
      workEndHour: 17,
      defaultDuration: 30,
      eventColor: "1",
    }),
    createActionToken: async (token: Omit<TokenRow, "id" | "usedAt">) => {
      const row = { ...token, id: `t${state.tokens.length + 1}`, usedAt: null }
      state.tokens.push(row)
      return row
    },
    getActionTokenByHash: async (hash: string) =>
      state.tokens.find((row) => row.tokenHash === hash),
    markActionTokenUsed: async (id: string) => {
      const row = state.tokens.find((item) => item.id === id && item.usedAt === null)
      if (!row) return undefined
      row.usedAt = new Date()
      return row
    },
    invalidateActionTokensForEvent: async (
      userId: string,
      eventId: string,
      calendarId: string,
      keepTokenHash?: string,
    ) => {
      for (const row of state.tokens) {
        if (
          row.userId === userId &&
          row.eventId === eventId &&
          row.calendarId === calendarId &&
          row.usedAt === null &&
          row.tokenHash !== keepTokenHash
        ) {
          row.usedAt = new Date()
        }
      }
    },
  },
}))

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn(function () {
        return { setCredentials: vi.fn(), on: vi.fn() }
      }),
    },
    calendar: vi.fn(() => ({
      events: {
        list: async () => ({ data: { items: [] } }),
        get: async () => ({ data: structuredClone(state.event) }),
        patch: async (call: { requestBody: Record<string, unknown> }) => {
          state.patches.push(call.requestBody)
          Object.assign(state.event, call.requestBody)
          return { data: structuredClone(state.event) }
        },
        insert: async () => ({ data: {} }),
      },
    })),
  },
}))

import {
  createActionPageHandler,
  createApiActionHandler,
} from "../../server/handlers/actionRoutes"
import { mapCalendarEventToTask } from "../../server/calendar"
import { createActionToken } from "../../server/tokens"
import { createMockResponse } from "../../server/handlers/testUtils"

const ROOT = path.resolve(import.meta.dirname, "..", "..")

function reset() {
  state.tokens.length = 0
  state.patches.length = 0
  state.event = {
    id: "evt-1",
    summary: "☑️ Water plants",
    description: "Old\n\nActions:\n- Manage: x\n\n---\nCreated by Todo",
    start: { dateTime: "2026-03-02T10:00:00.000Z" },
    end: { dateTime: "2026-03-02T10:30:00.000Z" },
    extendedProperties: { private: { caltodo: "true", caltodoCompleted: "false" } },
  }
}

async function post(action: string, accept: string) {
  reset()
  const { token } = await createActionToken("user-1", "evt-1", "primary")
  const response = createMockResponse()
  await createApiActionHandler()(
    {
      params: { token },
      user: { id: "user-1" },
      body: { action },
      headers: { accept },
    } as never,
    response.res as never,
    vi.fn(),
  )
  return {
    action,
    accept,
    status: response.statusCode,
    body: response.body,
    patchedFields: state.patches.map((patch) => Object.keys(patch as object).sort()),
    tokens: state.tokens.map((row) => ({ id: row.id, used: row.usedAt !== null })),
  }
}

describe("action flow fixture", () => {
  it("writes the action flow outcomes", async () => {
    const results = [
      await post("complete", "application/json"),
      await post("complete", "text/html,application/xhtml+xml"),
      await post("reschedule", "application/json"),
    ]
    const token = { userId: "user-1", eventId: "evt-1", calendarId: "primary" }
    const taskEvent = (completed: boolean, summary = '☑️ Water <plants> & "more"') => ({
      id: "evt-1",
      summary,
      start: { dateTime: "2026-03-02T10:00:00.000Z" },
      end: { dateTime: "2026-03-02T10:30:00.000Z" },
      extendedProperties: {
        private: { caltodo: "true", caltodoCompleted: completed ? "true" : "false" },
      },
    })
    const pageScenarios: Array<{
      name: string
      authenticated: boolean
      tokenParam: string
      record: unknown
      event: unknown
    }> = [
      {
        name: "signed out",
        authenticated: false,
        tokenParam: "raw/tok en?x",
        record: token,
        event: taskEvent(false),
      },
      {
        name: "invalid token",
        authenticated: true,
        tokenParam: "raw",
        record: null,
        event: null,
      },
      {
        name: "other user",
        authenticated: true,
        tokenParam: "raw",
        record: { ...token, userId: "user-2" },
        event: null,
      },
      {
        name: "deleted event",
        authenticated: true,
        tokenParam: "raw",
        record: token,
        event: null,
      },
      {
        name: "foreign event",
        authenticated: true,
        tokenParam: "raw",
        record: token,
        event: {
          id: "evt-1",
          summary: "Meeting",
          start: { dateTime: "2026-03-02T10:00:00.000Z" },
          end: { dateTime: "2026-03-02T10:30:00.000Z" },
        },
      },
      {
        name: "manage open task",
        authenticated: true,
        tokenParam: "raw-token_1",
        record: token,
        event: taskEvent(false),
      },
      {
        name: "manage completed task",
        authenticated: true,
        tokenParam: "raw-token_1",
        record: token,
        event: taskEvent(true),
      },
      {
        name: "manage untitled task",
        authenticated: true,
        tokenParam: "raw-token_1",
        record: token,
        event: taskEvent(false, "☑️ "),
      },
    ]
    const pages = []
    for (const scenario of pageScenarios) {
      const response = createMockResponse()
      await createActionPageHandler({
        getActionToken: async () => scenario.record as never,
        getCalendarEvent: async () => scenario.event as never,
        mapCalendarEventToTask,
      })(
        {
          params: { token: scenario.tokenParam },
          user: scenario.authenticated ? { id: "user-1" } : undefined,
          isAuthenticated: () => scenario.authenticated,
          session: { csrfToken: "csrf<\"&'>token" },
        } as never,
        response.res as never,
        vi.fn(),
      )
      pages.push({
        name: scenario.name,
        tokenParam: scenario.tokenParam,
        status: response.statusCode,
        html: response.body,
      })
    }
    const file = path.join(
      ROOT,
      "crates/server/tests/fixtures/node/action_flow.golden.json",
    )
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          source:
            "server/handlers/actionRoutes.ts with the real token and calendar modules (Node) at the commit that adds this file",
          results,
          pages,
        },
        null,
        2,
      )}\n`,
    )
  })
})
