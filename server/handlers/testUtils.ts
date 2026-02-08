export type MockResponse = {
  statusCode: number
  body: unknown
  redirectedTo: string | null
  clearedCookies: Array<{ name: string; options: unknown }>
  res: {
    status: (code: number) => MockResponse["res"]
    json: (payload: unknown) => MockResponse["res"]
    send: (payload: unknown) => MockResponse["res"]
    redirect: (path: string) => MockResponse["res"]
    clearCookie: (name: string, options?: unknown) => MockResponse["res"]
  }
}

export function createMockResponse(): MockResponse {
  const state: {
    statusCode: number
    body: unknown
    redirectedTo: string | null
    clearedCookies: Array<{ name: string; options: unknown }>
  } = {
    statusCode: 200,
    body: undefined,
    redirectedTo: null,
    clearedCookies: [],
  }

  const res = {
    status(code: number) {
      state.statusCode = code
      return this
    },
    json(payload: unknown) {
      state.body = payload
      return this
    },
    send(payload: unknown) {
      state.body = payload
      return this
    },
    redirect(path: string) {
      state.redirectedTo = path
      return this
    },
    clearCookie(name: string, options?: unknown) {
      state.clearedCookies.push({ name, options })
      return this
    },
  }

  return {
    get statusCode() {
      return state.statusCode
    },
    get body() {
      return state.body
    },
    get redirectedTo() {
      return state.redirectedTo
    },
    get clearedCookies() {
      return state.clearedCookies
    },
    res,
  }
}
