import type { User, UserSettings } from "@shared/schema";
import { setCsrfToken, getCsrfToken } from "./csrf";

export interface AuthUser extends User {
  settings?: UserSettings;
  csrfToken?: string;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const response = await fetch("/api/auth/user", {
      credentials: "include",
    });
    if (!response.ok) {
      return null;
    }
    const user = await response.json();
    if (user?.csrfToken) {
      setCsrfToken(user.csrfToken);
    }
    return user;
  } catch {
    return null;
  }
}

export function loginWithGoogle(): void {
  window.location.href = "/api/auth/google";
}

export async function logout(): Promise<void> {
  const csrfToken = getCsrfToken();
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
    headers: csrfToken ? { "X-CSRF-Token": csrfToken } : {},
  });
  window.location.href = "/";
}
