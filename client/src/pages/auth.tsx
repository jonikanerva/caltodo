import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Calendar, CheckSquare, Clock } from "lucide-react"
import { SiGoogle } from "react-icons/si"
import { loginWithGoogle } from "@/lib/auth"

export default function AuthPage() {
  return (
    <div className="flex-1 flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader className="text-center space-y-2">
            <div className="flex justify-center mb-4">
              <div className="flex items-center gap-2">
                <CheckSquare className="h-8 w-8 text-primary" />
                <span className="text-2xl font-semibold">Todo</span>
              </div>
            </div>
            <CardTitle className="text-2xl font-semibold">Welcome to Todo</CardTitle>
            <CardDescription className="text-base">
              Smart task management that automatically schedules your todos into your
              Google Calendar
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <Calendar className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-sm">Calendar Integration</p>
                  <p className="text-sm text-muted-foreground">
                    Tasks are automatically scheduled in your free time slots
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Clock className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-sm">Smart Rescheduling</p>
                  <p className="text-sm text-muted-foreground">
                    Incomplete tasks automatically move to the next available time
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <CheckSquare className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <p className="font-medium text-sm">Priority Control</p>
                  <p className="text-sm text-muted-foreground">
                    Drag to reorder and urgent tasks jump to the front
                  </p>
                </div>
              </div>
            </div>

            <Button
              className="w-full gap-2"
              size="lg"
              onClick={loginWithGoogle}
              data-testid="button-google-signin"
            >
              <SiGoogle className="h-4 w-4" />
              Sign in with Google
            </Button>

            <p className="text-xs text-muted-foreground text-center">
              We'll request access to your Google Calendar to schedule and manage tasks
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
