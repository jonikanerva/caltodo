import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import { createServer, type Server } from "http"
import { registerRoutes } from "./routes"
import { serveStatic } from "./static"
import { runMigrations } from "./db"

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown
  }
}

type AppContext = {
  app: Express
  httpServer: Server
  isProduction: boolean
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  })

  console.log(`${formattedTime} [${source}] ${message}`)
}

function getErrorStatus(error: unknown): number {
  if (typeof error === "object" && error !== null) {
    const withStatus = error as { status?: unknown; statusCode?: unknown }
    if (typeof withStatus.status === "number") {
      return withStatus.status
    }
    if (typeof withStatus.statusCode === "number") {
      return withStatus.statusCode
    }
  }
  return 500
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }
  return "Internal Server Error"
}

function applyCommonMiddleware(app: Express, isProduction: boolean): void {
  app.disable("x-powered-by")
  app.use(
    express.json({
      limit: "100kb",
      verify: (req, _res, buf) => {
        req.rawBody = buf
      },
    }),
  )
  app.use(express.urlencoded({ extended: false, limit: "50kb" }))
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: isProduction,
    }),
  )

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 25,
    standardHeaders: true,
    legacyHeaders: false,
  })

  const actionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
  })

  app.use("/api", apiLimiter)
  app.use("/api/auth/google", authLimiter)
  app.use("/api/auth/google/callback", authLimiter)
  app.use("/api/action", actionLimiter)
  app.use("/action", actionLimiter)

  app.use((req, res, next) => {
    const isDevelopment = !isProduction
    const scriptSrc = ["'self'"]
    if (isDevelopment) {
      scriptSrc.push("'unsafe-eval'")
    }

    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      `script-src ${scriptSrc.join(" ")}`,
      "connect-src 'self' ws: wss:",
    ].join("; ")

    res.setHeader("Content-Security-Policy", csp)
    res.setHeader("X-Frame-Options", "DENY")
    next()
  })

  app.use((req, _res, next) => {
    const start = Date.now()
    const path = req.path

    _res.on("finish", () => {
      const duration = Date.now() - start
      if (path.startsWith("/api")) {
        log(`${req.method} ${path} ${_res.statusCode} in ${duration}ms`)
      }
    })

    next()
  })
}

export function createApp(): AppContext {
  const app = express()
  const httpServer = createServer(app)
  const isProduction = process.env.NODE_ENV === "production"
  applyCommonMiddleware(app, isProduction)
  return { app, httpServer, isProduction }
}

export async function configureApp({
  app,
  httpServer,
  isProduction,
}: AppContext): Promise<void> {
  await runMigrations()
  await registerRoutes(httpServer, app)

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = getErrorStatus(err)
    const message = getErrorMessage(err)
    res.status(status).json({ message })
    if (status >= 500) {
      console.error(err)
    }
  })

  if (isProduction) {
    serveStatic(app)
  } else {
    const { setupVite } = await import("./vite")
    await setupVite(httpServer, app)
  }
}

export async function startServer(): Promise<Server> {
  const context = createApp()
  await configureApp(context)

  const port = parseInt(process.env.PORT || "5000", 10)
  return await new Promise<Server>((resolve) => {
    context.httpServer.listen(
      {
        port,
        host: "0.0.0.0",
        reusePort: true,
      },
      () => {
        log(`serving on port ${port}`)
        resolve(context.httpServer)
      },
    )
  })
}
