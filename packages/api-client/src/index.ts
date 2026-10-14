// The handwritten facade of the generated API client. The web app calls the
// API only through these functions.
//
// - The generated SDK validates every success body with the generated Zod
//   schema before a function returns it. `parseAs: 'json'` makes the SDK
//   parse every success body as JSON, so a body with another content type
//   also goes through the validator.
// - The SDK does not validate error bodies. `toFailure` validates them with
//   the generated Problem schema.
// - A failure with an HTTP response becomes an `ApiError` with the status, a
//   code, and the `detail` text. The message contains the status and the
//   detail, like the error text of the old client. A failure without a
//   response (network, abort) keeps its original error.
// - Every request that is not GET sends the CSRF token of the session as
//   `X-CSRF-Token`. `fetchCurrentUser` stores the token.
//
// Never edit `./generated`: run `pnpm --filter @caltodo/api-client run
// generate` after a change to `contract/openapi.json`.
//
// The first import turns off Zod's `eval` use before any schema exists.
import "./zodConfig.js"
import { createClient, createConfig } from "./generated/client/index.js"
import type { Client } from "./generated/client/index.js"
import * as sdk from "./generated/sdk.gen.js"
import type {
  AuthUser,
  CalendarListItem,
  CalendarTask,
  CreateTaskRequest,
  ProblemCode,
  RescheduleAllResult,
  UpdateSettingsRequest,
  UserSettings,
} from "./generated/types.gen.js"
import { zProblem, zUpdateSettingsRequest } from "./generated/zod.gen.js"

export type {
  AuthUser,
  CalendarListItem,
  CalendarTask,
  CreateTaskRequest,
  Problem,
  ProblemCode,
  RescheduleAllResult,
  RescheduleCounts,
  UpdateSettingsRequest,
  UserSettings,
} from "./generated/types.gen.js"

// The schema of the settings form: the request body of `PATCH /api/settings`.
export const updateSettingsRequestSchema = zUpdateSettingsRequest

// The HTTP status of each known problem code. `satisfies` makes the table
// exhaustive: a new code in the contract fails the type check until it has a
// row. A problem whose code and HTTP status disagree is not trusted.
const PROBLEM_STATUS = {
  invalid_request: 400,
  invalid_task_ids: 400,
  invalid_settings: 400,
  invalid_action: 400,
  no_calendar: 400,
  no_settings: 400,
  invalid_link: 400,
  invalid_event_time: 400,
  unauthenticated: 401,
  csrf_rejected: 403,
  forbidden: 403,
  not_found: 404,
  task_not_found: 404,
  no_tasks_to_reorder: 404,
  no_free_slot: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
  calendar_unavailable: 500,
  event_not_created: 500,
  google_unavailable: 502,
  google_reauthorization_required: 502,
  sign_in_failed: 502,
} as const satisfies Record<ProblemCode, number>

export const problemStatus = (code: ProblemCode): number => PROBLEM_STATUS[code]

// `invalid_response`: a success status with a body that breaks the contract.
// `unrecognized_error`: a failure status without a known problem body, for
// example an unknown code, an invalid body, or the HTML page of a proxy.
export type ApiErrorCode = ProblemCode | "invalid_response" | "unrecognized_error"

export class ApiError extends Error {
  override readonly name = "ApiError"
  readonly status: number
  readonly code: ApiErrorCode
  // The fixed `detail` text of a known problem.
  readonly detail: string | undefined

  constructor(
    status: number,
    code: ApiErrorCode,
    options: { detail?: string; cause?: unknown } = {},
  ) {
    super(`${String(status)}: ${options.detail ?? code}`, { cause: options.cause })
    this.status = status
    this.code = code
    this.detail = options.detail
  }
}

// The problem of a failure body, or `undefined` when the body is not a known
// problem of this status.
const knownProblem = (status: number, body: unknown) => {
  const parsed = zProblem.safeParse(body)
  if (!parsed.success || PROBLEM_STATUS[parsed.data.code] !== status) {
    return undefined
  }
  return parsed.data
}

// The error of a failed call. `body` is the parsed JSON body, the text of a
// non-JSON body, or a thrown error.
const toFailure = (body: unknown, response: Response | undefined): Error => {
  if (response === undefined) {
    return body instanceof Error
      ? body
      : new Error("The API request failed without an HTTP response.", { cause: body })
  }
  if (response.ok) {
    return new ApiError(response.status, "invalid_response", { cause: body })
  }
  const problem = knownProblem(response.status, body)
  if (problem === undefined) {
    return new ApiError(response.status, "unrecognized_error")
  }
  return new ApiError(response.status, problem.code, { detail: problem.detail })
}

type Success<T> = { data: T; error: undefined }
type SdkResult<T> = (Success<T> | { data: undefined; error: unknown }) & {
  response?: Response
}

// The client sets `error` on every failure, to `{}` at least, so a result
// without `error` is a success.
const isSuccess = <T>(result: SdkResult<T>): result is SdkResult<T> & Success<T> =>
  result.error === undefined

// True when the client returned a success without reading a body. The SDK
// then skips its validator: it does so for a 204 and a `Content-Length: 0`.
const skippedBody = (response: Response | undefined): boolean =>
  response === undefined ||
  response.status === 204 ||
  response.headers.get("Content-Length") === "0"

// The validated body of a call. Each caller names `T`: an inferred `T` would
// also take `undefined` from the failure branch.
const unwrap = async <T>(pending: Promise<SdkResult<T>>): Promise<T> => {
  const result = await pending
  if (!isSuccess(result)) {
    throw toFailure(result.error, result.response)
  }
  if (skippedBody(result.response)) {
    throw new ApiError(result.response?.status ?? 0, "invalid_response")
  }
  return result.data
}

export interface ApiConfig {
  // The origin of the API, read for each request.
  readonly baseUrl: () => string
  // The fetch implementation. The default is the global `fetch` at the time
  // of the request.
  readonly fetch?: typeof globalThis.fetch
}

export const createApi = (config: ApiConfig) => {
  // The CSRF token of the session (`GET /api/auth/user`).
  let csrfToken: string | undefined
  const client: Client = createClient(
    createConfig({
      // The generated SDK lists the `X-CSRF-Token` scheme on every request
      // that is not GET; the client then asks for the token here.
      auth: (auth) => (auth.name === "X-CSRF-Token" ? csrfToken : undefined),
    }),
  )
  const options = (signal?: AbortSignal) => ({
    client,
    baseUrl: config.baseUrl(),
    parseAs: "json" as const,
    // The session cookie is HttpOnly; the browser sends it.
    credentials: "same-origin" as const,
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    ...(signal === undefined ? {} : { signal }),
  })

  return {
    getCsrfToken: (): string | undefined => csrfToken,
    setCsrfToken: (token: string | undefined): void => {
      csrfToken = token
    },
    // The signed-in user, or `null` without a session (401). Stores the
    // CSRF token of the session.
    fetchCurrentUser: async (signal?: AbortSignal): Promise<AuthUser | null> => {
      try {
        const user = await unwrap<AuthUser>(sdk.getCurrentUser(options(signal)))
        csrfToken = user.csrfToken
        return user
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          return null
        }
        throw error
      }
    },
    logout: () => unwrap<{ success: boolean }>(sdk.logout(options())),
    deleteAccount: () => unwrap<{ success: boolean }>(sdk.deleteAccount(options())),
    fetchSettings: (signal?: AbortSignal) =>
      unwrap<UserSettings | null>(sdk.getSettings(options(signal))),
    updateSettings: (body: UpdateSettingsRequest) =>
      unwrap<UserSettings>(sdk.updateSettings({ ...options(), body })),
    fetchCalendars: (signal?: AbortSignal) =>
      unwrap<CalendarListItem[]>(sdk.listCalendars(options(signal))),
    fetchTasks: (signal?: AbortSignal) =>
      unwrap<CalendarTask[]>(sdk.listTasks(options(signal))),
    createTask: (body: CreateTaskRequest) =>
      unwrap<CalendarTask>(sdk.createTask({ ...options(), body })),
    updateTask: (id: string, completed: boolean) =>
      unwrap<CalendarTask>(
        sdk.updateTask({ ...options(), path: { id }, body: { completed } }),
      ),
    reorderTasks: (taskIds: string[]) =>
      unwrap<{ success: boolean }>(sdk.reorderTasks({ ...options(), body: { taskIds } })),
    reloadTasks: () => unwrap<{ success: boolean }>(sdk.reloadTasks(options())),
    rescheduleAllTasks: () =>
      unwrap<RescheduleAllResult>(sdk.rescheduleAllTasks(options())),
  }
}

export type Api = ReturnType<typeof createApi>

// The page origin in a browser. Without a page, the URL stays relative.
const pageOrigin = (): string => (typeof location === "undefined" ? "" : location.origin)

const api = createApi({ baseUrl: pageOrigin })

export const {
  getCsrfToken,
  setCsrfToken,
  fetchCurrentUser,
  logout,
  deleteAccount,
  fetchSettings,
  updateSettings,
  fetchCalendars,
  fetchTasks,
  createTask,
  updateTask,
  reorderTasks,
  reloadTasks,
  rescheduleAllTasks,
} = api
