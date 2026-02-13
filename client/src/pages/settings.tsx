import { useQuery, useMutation } from "@tanstack/react-query"
import { useLocation } from "wouter"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Settings, Calendar, Clock, Palette, Loader2, Save, Trash2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { queryClient, apiRequest } from "@/lib/queryClient"
import {
  updateSettingsSchema,
  type UpdateSettings,
  type UserSettings,
} from "@shared/schema"
import { z } from "zod"

interface CalendarListItem {
  id: string
  summary: string
  primary?: boolean
}

const getTimezoneOffset = (tz: string): string => {
  try {
    const now = new Date()
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    })
    const parts = formatter.formatToParts(now)
    const offsetPart = parts.find((p) => p.type === "timeZoneName")
    const gmtOffset = offsetPart?.value || ""
    // Convert GMT+02:00 to UTC+2, GMT-05:30 to UTC-5:30, GMT+0 to UTC+0
    const match = gmtOffset.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/)
    if (match) {
      const sign = match[1]
      const hours = parseInt(match[2], 10)
      const mins = match[3]
      // Only show minutes if they are non-zero (e.g., :30, :45)
      const minutes = mins && mins !== "00" ? `:${mins}` : ""
      return `UTC${sign}${hours}${minutes}`
    }
    return gmtOffset.replace("GMT", "UTC")
  } catch {
    return ""
  }
}

// Get numeric offset in minutes for sorting
const getOffsetMinutes = (tz: string): number => {
  try {
    const now = new Date()
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    })
    const parts = formatter.formatToParts(now)
    const offsetPart = parts.find((p) => p.type === "timeZoneName")
    const gmtOffset = offsetPart?.value || "GMT+0"
    const match = gmtOffset.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/)
    if (match) {
      const sign = match[1] === "+" ? 1 : -1
      const hours = parseInt(match[2], 10)
      const mins = parseInt(match[3] || "0", 10)
      return sign * (hours * 60 + mins)
    }
    return 0
  } catch {
    return 0
  }
}

const TIMEZONES = Intl.supportedValuesOf("timeZone").toSorted((a, b) => {
  const offsetA = getOffsetMinutes(a)
  const offsetB = getOffsetMinutes(b)
  // Sort by offset first, then alphabetically by name
  if (offsetA !== offsetB) {
    return offsetA - offsetB
  }
  return a.localeCompare(b)
})

const GOOGLE_CALENDAR_COLORS: { id: string; name: string; hex: string }[] = [
  { id: "1", name: "Lavender", hex: "#7986cb" },
  { id: "2", name: "Sage", hex: "#33b679" },
  { id: "3", name: "Grape", hex: "#8e24aa" },
  { id: "4", name: "Flamingo", hex: "#e67c73" },
  { id: "5", name: "Banana", hex: "#f6c026" },
  { id: "6", name: "Tangerine", hex: "#f5511d" },
  { id: "7", name: "Peacock", hex: "#039be5" },
  { id: "8", name: "Graphite", hex: "#616161" },
  { id: "9", name: "Blueberry", hex: "#3f51b5" },
  { id: "10", name: "Basil", hex: "#0b8043" },
  { id: "11", name: "Tomato", hex: "#d60000" },
]

type FormValues = {
  calendarId?: string
  workStartHour: number
  workEndHour: number
  timezone: string
  defaultDuration: number
  eventColor: string
}

export default function SettingsPage() {
  const { toast } = useToast()
  const [, setLocation] = useLocation()

  const { data: settings, isLoading: settingsLoading } = useQuery<UserSettings>({
    queryKey: ["/api/settings"],
  })

  const { data: calendars = [], isLoading: calendarsLoading } = useQuery<
    CalendarListItem[]
  >({
    queryKey: ["/api/calendars"],
  })

  const form = useForm<FormValues>({
    resolver: zodResolver(updateSettingsSchema),
    defaultValues: {
      calendarId: settings?.calendarId || "",
      workStartHour: settings?.workStartHour ?? 9,
      workEndHour: settings?.workEndHour ?? 17,
      timezone: settings?.timezone || "America/New_York",
      defaultDuration: settings?.defaultDuration ?? 60,
      eventColor: settings?.eventColor || "1",
    },
    values: settings
      ? {
          calendarId: settings.calendarId || "",
          workStartHour: settings.workStartHour,
          workEndHour: settings.workEndHour,
          timezone: settings.timezone,
          defaultDuration: settings.defaultDuration,
          eventColor: settings.eventColor,
        }
      : undefined,
  })

  const updateMutation = useMutation({
    mutationFn: async (data: FormValues) => {
      return apiRequest("PATCH", "/api/settings", data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings"] })
      queryClient.invalidateQueries({ queryKey: ["/api/auth/user"] })
      toast({
        title: "Settings saved",
        description: "Your preferences have been updated",
      })
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to save settings. Please try again.",
        variant: "destructive",
      })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", "/api/account")
    },
    onSuccess: () => {
      queryClient.setQueryData(["/api/auth/user"], null)
      queryClient.removeQueries({ queryKey: ["/api/settings"] })
      queryClient.removeQueries({ queryKey: ["/api/calendars"] })
      toast({
        title: "Account data deleted",
        description: "Your stored data has been removed.",
      })
      setLocation("/")
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete your data. Please try again.",
        variant: "destructive",
      })
    },
  })

  const onSubmit = (data: FormValues) => {
    updateMutation.mutate(data)
  }

  const formatHour = (hour: number) => {
    return `${hour.toString().padStart(2, "0")}:00`
  }

  if (settingsLoading) {
    return (
      <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="space-y-6">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Settings
          </CardTitle>
          <CardDescription>
            Configure your calendar preferences and work hours
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <FormField
                control={form.control}
                name="calendarId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <Calendar className="h-4 w-4" />
                      Calendar
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={calendarsLoading}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-calendar">
                          <SelectValue placeholder="Select a calendar" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {calendars.map((cal) => (
                          <SelectItem key={cal.id} value={cal.id}>
                            {cal.summary} {cal.primary && "(Primary)"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Select which calendar to use for scheduling tasks
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-6 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="workStartHour"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-2">
                        <Clock className="h-4 w-4" />
                        Work Start Time
                      </FormLabel>
                      <Select
                        onValueChange={(v) => field.onChange(parseInt(v))}
                        value={String(field.value)}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-work-start">
                            <SelectValue placeholder="Select start time" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Array.from({ length: 24 }, (_, i) => (
                            <SelectItem key={i} value={String(i)}>
                              {formatHour(i)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="workEndHour"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="flex items-center gap-2">
                        <Clock className="h-4 w-4" />
                        Work End Time
                      </FormLabel>
                      <Select
                        onValueChange={(v) => field.onChange(parseInt(v))}
                        value={String(field.value)}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-work-end">
                            <SelectValue placeholder="Select end time" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Array.from({ length: 24 }, (_, i) => (
                            <SelectItem key={i} value={String(i)}>
                              {formatHour(i)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Timezone</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-timezone">
                          <SelectValue placeholder="Select timezone" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {TIMEZONES.map((tz) => (
                          <SelectItem key={tz} value={tz}>
                            {tz.replace(/_/g, " ")} ({getTimezoneOffset(tz)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="defaultDuration"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Default Task Duration</FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={(v) => field.onChange(parseInt(v))}
                        value={String(field.value)}
                        className="flex flex-wrap gap-4"
                      >
                        {[
                          { value: "15", label: "15 min" },
                          { value: "30", label: "30 min" },
                          { value: "60", label: "1 hour" },
                          { value: "90", label: "1.5 hours" },
                          { value: "120", label: "2 hours" },
                        ].map((option) => (
                          <div key={option.value} className="flex items-center gap-2">
                            <RadioGroupItem
                              value={option.value}
                              id={`duration-${option.value}`}
                              data-testid={`radio-duration-${option.value}`}
                            />
                            <Label
                              htmlFor={`duration-${option.value}`}
                              className="cursor-pointer"
                            >
                              {option.label}
                            </Label>
                          </div>
                        ))}
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="eventColor"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <Palette className="h-4 w-4" />
                      Event Color
                    </FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={field.onChange}
                        value={field.value}
                        className="flex flex-wrap gap-2"
                      >
                        {GOOGLE_CALENDAR_COLORS.map((color) => (
                          <div key={color.id} className="flex items-center">
                            <RadioGroupItem
                              value={color.id}
                              id={`color-${color.id}`}
                              className="sr-only"
                              data-testid={`radio-color-${color.id}`}
                            />
                            <Label
                              htmlFor={`color-${color.id}`}
                              className={`w-8 h-8 rounded-full cursor-pointer ring-offset-2 ring-offset-background transition-all ${
                                field.value === color.id
                                  ? "ring-2 ring-primary scale-110"
                                  : "hover:scale-105"
                              }`}
                              style={{ backgroundColor: color.hex }}
                              title={color.name}
                            />
                          </div>
                        ))}
                      </RadioGroup>
                    </FormControl>
                    <FormDescription>
                      Choose a color for your scheduled tasks in Google Calendar
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end">
                <Button
                  type="submit"
                  disabled={updateMutation.isPending}
                  data-testid="button-save-settings"
                >
                  {updateMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <Save className="h-4 w-4 mr-2" />
                  )}
                  Save Settings
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            Data Management
          </CardTitle>
          <CardDescription>
            Permanently remove your Todo account data stored in the app.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            This deletes your saved settings, OAuth tokens, and action links stored in
            Todo. Calendar events stay in your Google Calendar.
          </p>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                disabled={deleteMutation.isPending}
                data-testid="button-delete-data"
              >
                Delete all data
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete all data?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. Your Todo account data will be removed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteMutation.isPending}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction
                  className={buttonVariants({ variant: "destructive" })}
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                >
                  Delete all data
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardContent>
      </Card>
    </div>
  )
}
