import { ApiError, logout as requestLogout } from "@caltodo/api-client"

export function loginWithGoogle(): void {
  window.location.assign("/api/auth/google")
}

// Signs out and reloads the start page. A refused sign-out (for example a
// session that already ended) still goes to the start page, like the
// original client.
export async function logout(): Promise<void> {
  try {
    await requestLogout()
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error
    }
  }
  window.location.assign("/")
}
