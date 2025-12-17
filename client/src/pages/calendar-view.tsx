import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  ChevronLeft, 
  ChevronRight, 
  CalendarDays,
  AlertTriangle,
  Clock
} from "lucide-react";
import type { Task, UserSettings } from "@shared/schema";
import { format, startOfWeek, endOfWeek, eachDayOfInterval, isSameDay, addWeeks, subWeeks, addDays, subDays, startOfDay, isToday } from "date-fns";

type ViewMode = "day" | "week";

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export default function CalendarViewPage() {
  const [viewMode, setViewMode] = useState<ViewMode>("week");
  const [currentDate, setCurrentDate] = useState(new Date());

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
  });

  const { data: settings } = useQuery<UserSettings | null>({
    queryKey: ["/api/settings"],
  });

  const scheduledTasks = tasks.filter((t) => !t.completed && t.scheduledStart);

  const navigateBack = () => {
    if (viewMode === "week") {
      setCurrentDate(subWeeks(currentDate, 1));
    } else {
      setCurrentDate(subDays(currentDate, 1));
    }
  };

  const navigateForward = () => {
    if (viewMode === "week") {
      setCurrentDate(addWeeks(currentDate, 1));
    } else {
      setCurrentDate(addDays(currentDate, 1));
    }
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(currentDate, { weekStartsOn: 1 });
  const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd });

  const workStartHour = settings?.workStartHour ?? 9;
  const workEndHour = settings?.workEndHour ?? 17;
  const displayHours = HOURS.filter((h) => h >= workStartHour - 1 && h <= workEndHour + 1);

  const getTasksForDay = (day: Date) => {
    return scheduledTasks.filter((task) => {
      if (!task.scheduledStart) return false;
      return isSameDay(new Date(task.scheduledStart), day);
    });
  };

  const getTaskPosition = (task: Task) => {
    if (!task.scheduledStart || !task.scheduledEnd) return null;
    const start = new Date(task.scheduledStart);
    const end = new Date(task.scheduledEnd);
    const startHour = start.getHours() + start.getMinutes() / 60;
    const endHour = end.getHours() + end.getMinutes() / 60;
    const duration = endHour - startHour;
    
    const firstDisplayHour = displayHours[0];
    const topPercent = ((startHour - firstDisplayHour) / displayHours.length) * 100;
    const heightPercent = (duration / displayHours.length) * 100;
    
    return { top: `${topPercent}%`, height: `${Math.max(heightPercent, 3)}%` };
  };

  if (isLoading) {
    return (
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <div className="space-y-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-[600px] w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-4">
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              Calendar View
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant={viewMode === "day" ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode("day")}
                data-testid="button-view-day"
              >
                Day
              </Button>
              <Button
                variant={viewMode === "week" ? "default" : "outline"}
                size="sm"
                onClick={() => setViewMode("week")}
                data-testid="button-view-week"
              >
                Week
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 mt-4">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" onClick={navigateBack} data-testid="button-nav-back">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={goToToday} data-testid="button-today">
                Today
              </Button>
              <Button variant="outline" size="icon" onClick={navigateForward} data-testid="button-nav-forward">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <span className="text-sm font-medium text-muted-foreground">
              {viewMode === "week" 
                ? `${format(weekStart, "MMM d")} - ${format(weekEnd, "MMM d, yyyy")}`
                : format(currentDate, "EEEE, MMMM d, yyyy")
              }
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {viewMode === "week" ? (
            <div className="grid grid-cols-8 border rounded-md overflow-hidden">
              <div className="bg-muted/30">
                <div className="h-12 border-b" />
                {displayHours.map((hour) => (
                  <div 
                    key={hour} 
                    className="h-16 border-b text-xs text-muted-foreground px-2 pt-1"
                  >
                    {format(new Date().setHours(hour, 0), "ha")}
                  </div>
                ))}
              </div>
              {weekDays.map((day) => {
                const dayTasks = getTasksForDay(day);
                const dayIsToday = isToday(day);
                return (
                  <div key={day.toISOString()} className="border-l relative">
                    <div className={`h-12 border-b p-2 text-center ${dayIsToday ? "bg-primary/10" : "bg-muted/20"}`}>
                      <div className="text-xs text-muted-foreground">{format(day, "EEE")}</div>
                      <div className={`text-sm font-medium ${dayIsToday ? "text-primary" : ""}`}>
                        {format(day, "d")}
                      </div>
                    </div>
                    <div className="relative" style={{ height: `${displayHours.length * 64}px` }}>
                      {displayHours.map((hour) => (
                        <div 
                          key={hour} 
                          className={`h-16 border-b ${hour >= workStartHour && hour < workEndHour ? "" : "bg-muted/20"}`} 
                        />
                      ))}
                      {dayTasks.map((task) => {
                        const position = getTaskPosition(task);
                        if (!position) return null;
                        return (
                          <div
                            key={task.id}
                            className={`absolute left-0.5 right-0.5 rounded-md p-1 text-xs overflow-hidden ${
                              task.urgent 
                                ? "bg-destructive/20 border border-destructive/40" 
                                : "bg-primary/20 border border-primary/40"
                            }`}
                            style={position}
                            data-testid={`calendar-task-${task.id}`}
                          >
                            <div className="font-medium truncate">{task.title}</div>
                            {task.scheduledStart && (
                              <div className="text-muted-foreground truncate">
                                {format(new Date(task.scheduledStart), "h:mm a")}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-2 border rounded-md overflow-hidden">
              <div className="bg-muted/30">
                {displayHours.map((hour) => (
                  <div 
                    key={hour} 
                    className="h-20 border-b text-xs text-muted-foreground px-2 pt-1"
                  >
                    {format(new Date().setHours(hour, 0), "h:mm a")}
                  </div>
                ))}
              </div>
              <div className="border-l relative">
                <div className="relative" style={{ height: `${displayHours.length * 80}px` }}>
                  {displayHours.map((hour) => (
                    <div 
                      key={hour} 
                      className={`h-20 border-b ${hour >= workStartHour && hour < workEndHour ? "" : "bg-muted/20"}`} 
                    />
                  ))}
                  {getTasksForDay(startOfDay(currentDate)).map((task) => {
                    const position = getTaskPosition(task);
                    if (!position) return null;
                    return (
                      <div
                        key={task.id}
                        className={`absolute left-1 right-1 rounded-md p-2 overflow-hidden ${
                          task.urgent 
                            ? "bg-destructive/20 border border-destructive/40" 
                            : "bg-primary/20 border border-primary/40"
                        }`}
                        style={position}
                        data-testid={`calendar-task-${task.id}`}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{task.title}</span>
                          {task.urgent && (
                            <AlertTriangle className="h-3 w-3 text-destructive" />
                          )}
                        </div>
                        {task.scheduledStart && task.scheduledEnd && (
                          <div className="text-sm text-muted-foreground flex items-center gap-1 mt-1">
                            <Clock className="h-3 w-3" />
                            {format(new Date(task.scheduledStart), "h:mm a")} - {format(new Date(task.scheduledEnd), "h:mm a")}
                          </div>
                        )}
                        {task.details && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {task.details}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {scheduledTasks.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <p className="text-muted-foreground">
              No scheduled tasks to display. Create tasks and configure your calendar to see them here.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
