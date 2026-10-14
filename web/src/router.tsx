import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useLocation,
} from "@tanstack/react-router"
import { QueryClientProvider, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { queryClient } from "./lib/queryClient"
import { currentUserQuery } from "./lib/queries"
import { Toaster } from "@/components/ui/toaster"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ThemeToggle } from "@/components/theme-toggle"
import { CheckSquare, Settings, ListTodo, LogOut } from "lucide-react"
import AuthPage from "@/pages/auth"
import MainPage from "@/pages/main"
import SettingsPage from "@/pages/settings"
import NotFound from "@/pages/not-found"
import PrivacyPage from "@/pages/privacy"
import TermsPage from "@/pages/tos"
import { logout } from "@/lib/auth"

function Footer() {
  const year = new Date().getFullYear()

  return (
    <footer className="border-t bg-background">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <p className="text-center text-xs text-muted-foreground/70">
          Copyright donut <span aria-hidden="true">&copy;</span> {year}.{" "}
          <Link to="/privacy" className="hover:text-muted-foreground">
            Privacy Policy
          </Link>
          .{" "}
          <Link to="/tos" className="hover:text-muted-foreground">
            TOS
          </Link>
          .
        </p>
      </div>
    </footer>
  )
}

function PublicLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 flex flex-col">{children}</main>
      <Footer />
    </div>
  )
}

function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation({ select: (current) => current.pathname })
  const { data: user } = useQuery(currentUserQuery)

  const handleLogout = async () => {
    await logout()
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <CheckSquare className="h-6 w-6 text-primary" />
            <span className="font-semibold text-lg">Todo</span>
          </div>

          <nav className="flex items-center gap-1">
            <Link to="/">
              <Button
                variant={location === "/" ? "secondary" : "ghost"}
                size="sm"
                className="gap-2"
                data-testid="nav-tasks"
              >
                <ListTodo className="h-4 w-4" />
                <span className="hidden sm:inline">Tasks</span>
              </Button>
            </Link>
            <Link to="/settings">
              <Button
                variant={location === "/settings" ? "secondary" : "ghost"}
                size="sm"
                className="gap-2"
                data-testid="nav-settings"
              >
                <Settings className="h-4 w-4" />
                <span className="hidden sm:inline">Settings</span>
              </Button>
            </Link>
          </nav>

          <div className="flex items-center gap-2">
            <ThemeToggle />
            {user && (
              <>
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs">
                    {user.displayName.charAt(0).toUpperCase() || "U"}
                  </AvatarFallback>
                </Avatar>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void handleLogout()}
                  data-testid="button-logout"
                >
                  <LogOut className="h-4 w-4" />
                  <span className="sr-only">Logout</span>
                </Button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>
      <Footer />
    </div>
  )
}

const PUBLIC_PATHS = new Set(["/privacy", "/tos"])

// The layout of every page. The public pages need no sign-in; every other
// path shows the sign-in page until the user is signed in.
function RootLayout() {
  const location = useLocation({ select: (current) => current.pathname })
  const isPublicRoute = PUBLIC_PATHS.has(location)
  const {
    data: user,
    isLoading,
    error,
  } = useQuery({ ...currentUserQuery, enabled: !isPublicRoute })

  if (isPublicRoute) {
    return (
      <PublicLayout>
        <Outlet />
      </PublicLayout>
    )
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    )
  }

  if (!user || error) {
    return (
      <PublicLayout>
        <AuthPage />
      </PublicLayout>
    )
  }

  return (
    <AppLayout>
      <Outlet />
    </AppLayout>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <RootLayout />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

const rootRoute = createRootRoute({
  component: App,
  notFoundComponent: NotFound,
})

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: MainPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    component: SettingsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/privacy",
    component: PrivacyPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/tos", component: TermsPage }),
])

export const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
