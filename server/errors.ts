import { ZodError } from "zod"

export class AppError extends Error {
  readonly status: number
  readonly expose: boolean

  constructor(message: string, status: number, expose = true) {
    super(message)
    this.name = this.constructor.name
    this.status = status
    this.expose = expose
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400)
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized.") {
    super(message, 403)
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404)
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409)
  }
}

export function normalizeError(
  error: unknown,
  fallbackMessage: string,
): { status: number; message: string } {
  if (error instanceof AppError) {
    return { status: error.status, message: error.message }
  }
  if (error instanceof ZodError) {
    return { status: 400, message: "Invalid request payload" }
  }
  return { status: 500, message: fallbackMessage }
}
