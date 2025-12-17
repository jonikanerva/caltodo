let csrfToken: string | undefined;

export function setCsrfToken(token?: string | null) {
  csrfToken = token ?? undefined;
}

export function getCsrfToken(): string | undefined {
  return csrfToken;
}
