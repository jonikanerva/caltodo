import { Switch, Route, Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ThemeToggle } from "@/components/theme-toggle";
import { CheckSquare, Settings, ListTodo, LogOut } from "lucide-react";
import AuthPage from "@/pages/auth";
import MainPage from "@/pages/main";
import SettingsPage from "@/pages/settings";
import NotFound from "@/pages/not-found";
import PrivacyPage from "@/pages/privacy";
import TermsPage from "@/pages/tos";
import { logout } from "@/lib/auth";
import type { User, UserSettings } from "@shared/schema";

interface AuthUser extends User {
  settings?: UserSettings;
}

function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t bg-background">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <p className="text-xs text-muted-foreground">
          Copyright donut <span aria-hidden="true">&copy;</span> {year}.{" "}
          <Link href="/privacy" className="underline underline-offset-4 hover:text-foreground">
            Privacy Policy
          </Link>
          .{" "}
          <Link href="/tos" className="underline underline-offset-4 hover:text-foreground">
            TOS
          </Link>
          .
        </p>
      </div>
    </footer>
  );
}

function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 flex flex-col">{children}</main>
      <Footer />
    </div>
  );
}

function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: user } = useQuery<AuthUser>({
    queryKey: ["/api/auth/user"],
  });

  const handleLogout = async () => {
    await logout();
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <CheckSquare className="h-6 w-6 text-primary" />
            <span className="font-semibold text-lg">CalTodo</span>
          </div>

          <nav className="flex items-center gap-1">
            <Link href="/">
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
            <Link href="/settings">
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
                    {user.displayName?.charAt(0).toUpperCase() || "U"}
                  </AvatarFallback>
                </Avatar>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleLogout}
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
  );
}

function AuthenticatedRoutes() {
  return (
    <AppLayout>
      <Switch>
        <Route path="/" component={MainPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route component={NotFound} />
      </Switch>
    </AppLayout>
  );
}

function Router() {
  const [location] = useLocation();
  const isPublicRoute = location === "/privacy" || location === "/tos";
  const { data: user, isLoading, error } = useQuery<AuthUser>({
    queryKey: ["/api/auth/user"],
    retry: false,
    enabled: !isPublicRoute,
  });

  if (isPublicRoute) {
    return (
      <PublicLayout>
        <Switch>
          <Route path="/privacy" component={PrivacyPage} />
          <Route path="/tos" component={TermsPage} />
          <Route component={NotFound} />
        </Switch>
      </PublicLayout>
    );
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  if (!user || error) {
    return (
      <PublicLayout>
        <AuthPage />
      </PublicLayout>
    );
  }

  return <AuthenticatedRoutes />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
