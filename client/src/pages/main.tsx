import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Link } from "wouter";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Plus, 
  GripVertical, 
  ChevronDown, 
  ChevronUp, 
  RotateCcw, 
  Clock,
  AlertTriangle,
  Loader2,
  Settings,
  Pencil,
  Check,
  X,
  RefreshCw,
  Trash2,
  Bell,
  RotateCw
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Task, UserSettings } from "@shared/schema";
import { format } from "date-fns";

interface CreateTaskInput {
  title: string;
  details: string;
  urgent: boolean;
  duration?: number;
  reminderMinutes?: number;
}

interface EditingTask {
  id: string;
  title: string;
  details: string;
  duration: number | null;
  reminderMinutes: number | null;
}

const REMINDER_OPTIONS = [
  { value: "0", label: "At time of event" },
  { value: "5", label: "5 min before" },
  { value: "10", label: "10 min before" },
  { value: "15", label: "15 min before" },
  { value: "30", label: "30 min before" },
  { value: "60", label: "1 hour before" },
];

const DURATION_OPTIONS = [
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "45", label: "45 min" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
  { value: "120", label: "2 hours" },
  { value: "180", label: "3 hours" },
  { value: "240", label: "4 hours" },
];

export default function MainPage() {
  const { toast } = useToast();
  const [newTask, setNewTask] = useState<CreateTaskInput>({
    title: "",
    details: "",
    urgent: false,
  });
  const [completedOpen, setCompletedOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<EditingTask | null>(null);
  const [completingTaskIds, setCompletingTaskIds] = useState<Set<string>>(new Set());
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  const { data: tasks = [], isLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
  });

  const { data: settings } = useQuery<UserSettings | null>({
    queryKey: ["/api/settings"],
  });

  const hasCalendar = !!settings?.calendarId;

  const createTaskMutation = useMutation({
    mutationFn: async (data: CreateTaskInput) => {
      return apiRequest("POST", "/api/tasks", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      setNewTask({ title: "", details: "", urgent: false, duration: undefined });
      toast({
        title: "Task created",
        description: hasCalendar 
          ? "Your task has been scheduled in your calendar"
          : "Task saved. Configure a calendar to enable scheduling.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to create task. Please try again.",
        variant: "destructive",
      });
    },
  });

  const completeTaskMutation = useMutation({
    mutationFn: async ({ id, completed }: { id: string; completed: boolean }) => {
      // Add to completing set immediately for optimistic UI
      setCompletingTaskIds(prev => new Set(prev).add(id));
      return apiRequest("PATCH", `/api/tasks/${id}`, { completed });
    },
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      // Remove from completing set after success
      setCompletingTaskIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
    onError: (_, { id }) => {
      // Remove from completing set on error
      setCompletingTaskIds(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
  });

  const reorderTasksMutation = useMutation({
    mutationFn: async (taskIds: string[]) => {
      return apiRequest("POST", "/api/tasks/reorder", { taskIds });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    },
  });

  const editTaskMutation = useMutation({
    mutationFn: async ({ id, title, details, duration, reminderMinutes }: { id: string; title: string; details: string; duration: number | null; reminderMinutes: number | null }) => {
      return apiRequest("PUT", `/api/tasks/${id}`, { title, details, duration, reminderMinutes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      setEditingTask(null);
      toast({
        title: "Task updated",
        description: hasCalendar 
          ? "Your task and calendar event have been updated"
          : "Your task has been updated",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update task. Please try again.",
        variant: "destructive",
      });
    },
  });

  const reloadCalendarMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/tasks/reload", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({
        title: "Calendar synced",
        description: "Task times have been updated from Google Calendar",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to sync calendar. Please try again.",
        variant: "destructive",
      });
    },
  });

  const rescheduleAllMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/tasks/reschedule-all", {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({
        title: "Tasks rescheduled",
        description: "All incomplete tasks have been rescheduled",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to reschedule tasks. Please try again.",
        variant: "destructive",
      });
    },
  });

  const deleteCompletedMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", "/api/tasks/completed", {});
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({
        title: "Tasks deleted",
        description: `${data.deleted} completed task(s) have been removed`,
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to delete tasks. Please try again.",
        variant: "destructive",
      });
    },
  });

  const startEditing = (task: Task) => {
    setEditingTask({
      id: task.id,
      title: task.title,
      details: task.details || "",
      duration: task.duration,
      reminderMinutes: task.reminderMinutes,
    });
  };

  const cancelEditing = () => {
    setEditingTask(null);
  };

  const saveEditing = () => {
    if (!editingTask || !editingTask.title.trim()) return;
    editTaskMutation.mutate(editingTask);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTask.title.trim()) return;
    createTaskMutation.mutate(newTask);
  };

  const handleDragEnd = (result: DropResult) => {
    if (!result.destination) return;
    
    const uncompletedTasks = tasks.filter((t) => !t.completed);
    const items = Array.from(uncompletedTasks);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);
    
    const newOrder = items.map((t) => t.id);
    reorderTasksMutation.mutate(newOrder);
  };

  const uncompletedTasks = tasks.filter((t) => !t.completed).sort((a, b) => a.priority - b.priority);
  const completedTasks = tasks
    .filter((t) => t.completed)
    .sort((a, b) => {
      const dateA = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const dateB = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return dateB - dateA;
    });

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-8 space-y-6">
      {!hasCalendar && settings !== undefined && (
        <Alert data-testid="alert-no-calendar">
          <Settings className="h-4 w-4" />
          <AlertTitle>No calendar selected</AlertTitle>
          <AlertDescription className="flex items-center justify-between gap-4 flex-wrap">
            <span>Select a calendar in settings to enable automatic task scheduling.</span>
            <Link href="/settings">
              <Button variant="outline" size="sm">
                Go to Settings
              </Button>
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg font-semibold flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Create a Task
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Input
                ref={titleInputRef}
                placeholder="What needs to be done?"
                value={newTask.title}
                onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                className="text-base"
                data-testid="input-task-title"
              />
            </div>
            <div className="space-y-2">
              <Textarea
                placeholder="Add details (optional)"
                value={newTask.details}
                onChange={(e) => setNewTask({ ...newTask, details: e.target.value })}
                rows={3}
                data-testid="textarea-task-details"
              />
            </div>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="urgent"
                    checked={newTask.urgent}
                    onCheckedChange={(checked) => 
                      setNewTask({ ...newTask, urgent: checked === true })
                    }
                    data-testid="checkbox-urgent"
                  />
                  <Label htmlFor="urgent" className="flex items-center gap-1 text-sm cursor-pointer">
                    <AlertTriangle className="h-4 w-4 text-destructive" />
                    Urgent
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-muted-foreground">Duration:</Label>
                  <Select
                    value={newTask.duration?.toString() || "default"}
                    onValueChange={(val) => 
                      setNewTask({ ...newTask, duration: val === "default" ? undefined : parseInt(val) })
                    }
                  >
                    <SelectTrigger className="w-28" data-testid="select-duration">
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {DURATION_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <Label className="text-sm text-muted-foreground">Reminder:</Label>
                  <Select
                    value={newTask.reminderMinutes?.toString() || "none"}
                    onValueChange={(val) => 
                      setNewTask({ ...newTask, reminderMinutes: val === "none" ? undefined : parseInt(val) })
                    }
                  >
                    <SelectTrigger className="w-32" data-testid="select-reminder">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No reminder</SelectItem>
                      {REMINDER_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <Button 
                type="submit" 
                disabled={!newTask.title.trim() || createTaskMutation.isPending}
                data-testid="button-create-task"
              >
                {createTaskMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Plus className="h-4 w-4 mr-2" />
                )}
                Create Task
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 px-1 flex-wrap">
          <h2 className="text-lg font-semibold">Tasks</h2>
          <div className="flex items-center gap-2">
            {hasCalendar && uncompletedTasks.length > 0 && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => reloadCalendarMutation.mutate()}
                  disabled={reloadCalendarMutation.isPending}
                  data-testid="button-reload-calendar"
                >
                  {reloadCalendarMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <RotateCw className="h-4 w-4 mr-2" />
                  )}
                  Reload
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => rescheduleAllMutation.mutate()}
                  disabled={rescheduleAllMutation.isPending}
                  data-testid="button-reschedule-all"
                >
                  {rescheduleAllMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  Reschedule All
                </Button>
              </>
            )}
          </div>
        </div>
        
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-5 w-5 rounded" />
                    <Skeleton className="h-5 flex-1" />
                    <Skeleton className="h-5 w-20" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : uncompletedTasks.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-muted-foreground">No tasks yet. Create one above to get started!</p>
            </CardContent>
          </Card>
        ) : (
          <DragDropContext onDragEnd={handleDragEnd}>
            <Droppable droppableId="tasks" isDropDisabled={reloadCalendarMutation.isPending || rescheduleAllMutation.isPending || reorderTasksMutation.isPending}>
              {(provided) => (
                <div
                  {...provided.droppableProps}
                  ref={provided.innerRef}
                  className={`space-y-2 transition-opacity ${
                    reloadCalendarMutation.isPending || rescheduleAllMutation.isPending || reorderTasksMutation.isPending ? "opacity-50 pointer-events-none" : ""
                  }`}
                >
                  {uncompletedTasks.map((task, index) => (
                    <Draggable 
                      key={task.id} 
                      draggableId={task.id} 
                      index={index}
                      isDragDisabled={reloadCalendarMutation.isPending || rescheduleAllMutation.isPending || reorderTasksMutation.isPending}
                    >
                      {(provided, snapshot) => (
                        <Card
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          className={`transition-shadow ${
                            snapshot.isDragging ? "shadow-lg ring-2 ring-primary/20" : ""
                          }`}
                          data-testid={`card-task-${task.id}`}
                        >
                          <CardContent className="p-4">
                            {editingTask?.id === task.id ? (
                              <div className="space-y-3">
                                <Input
                                  value={editingTask.title}
                                  onChange={(e) => setEditingTask({ ...editingTask, title: e.target.value })}
                                  placeholder="Task title"
                                  className="font-medium"
                                  data-testid={`input-edit-title-${task.id}`}
                                />
                                <Textarea
                                  value={editingTask.details}
                                  onChange={(e) => setEditingTask({ ...editingTask, details: e.target.value })}
                                  placeholder="Task details (optional)"
                                  rows={2}
                                  data-testid={`textarea-edit-details-${task.id}`}
                                />
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                  <div className="flex items-center gap-4 flex-wrap">
                                    <div className="flex items-center gap-2">
                                      <Label className="text-sm text-muted-foreground">Duration:</Label>
                                      <Select
                                        value={editingTask.duration?.toString() || "default"}
                                        onValueChange={(val) => 
                                          setEditingTask({ ...editingTask, duration: val === "default" ? null : parseInt(val) })
                                        }
                                      >
                                        <SelectTrigger className="w-28" data-testid={`select-edit-duration-${task.id}`}>
                                          <SelectValue placeholder="Default" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="default">Default</SelectItem>
                                          {DURATION_OPTIONS.map((opt) => (
                                            <SelectItem key={opt.value} value={opt.value}>
                                              {opt.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <Label className="text-sm text-muted-foreground">Reminder:</Label>
                                      <Select
                                        value={editingTask.reminderMinutes?.toString() || "none"}
                                        onValueChange={(val) => 
                                          setEditingTask({ ...editingTask, reminderMinutes: val === "none" ? null : parseInt(val) })
                                        }
                                      >
                                        <SelectTrigger className="w-32" data-testid={`select-edit-reminder-${task.id}`}>
                                          <SelectValue placeholder="None" />
                                        </SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="none">No reminder</SelectItem>
                                          {REMINDER_OPTIONS.map((opt) => (
                                            <SelectItem key={opt.value} value={opt.value}>
                                              {opt.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={cancelEditing}
                                      data-testid={`button-cancel-edit-${task.id}`}
                                    >
                                      <X className="h-4 w-4 mr-1" />
                                      Cancel
                                    </Button>
                                    <Button
                                      size="sm"
                                      onClick={saveEditing}
                                      disabled={!editingTask.title.trim() || editTaskMutation.isPending}
                                      data-testid={`button-save-edit-${task.id}`}
                                    >
                                      {editTaskMutation.isPending ? (
                                        <Loader2 className="h-4 w-4 animate-spin mr-1" />
                                      ) : (
                                        <Check className="h-4 w-4 mr-1" />
                                      )}
                                      Save
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className={`flex items-start gap-3 transition-opacity ${
                                completingTaskIds.has(task.id) ? "opacity-50 pointer-events-none" : ""
                              }`}>
                                <div
                                  {...provided.dragHandleProps}
                                  className="mt-0.5 cursor-grab active:cursor-grabbing text-muted-foreground"
                                >
                                  <GripVertical className="h-5 w-5" />
                                </div>
                                <Checkbox
                                  checked={completingTaskIds.has(task.id)}
                                  disabled={completingTaskIds.has(task.id)}
                                  onCheckedChange={() =>
                                    completeTaskMutation.mutate({
                                      id: task.id,
                                      completed: true,
                                    })
                                  }
                                  className="mt-0.5"
                                  data-testid={`checkbox-complete-${task.id}`}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-medium">{task.title}</span>
                                    {task.urgent && (
                                      <Badge variant="destructive" className="text-xs">
                                        <AlertTriangle className="h-3 w-3 mr-1" />
                                        Urgent
                                      </Badge>
                                    )}
                                  </div>
                                  {task.details && (
                                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                                      {task.details}
                                    </p>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  {task.duration && (
                                    <Badge variant="outline" className="gap-1 text-xs">
                                      {task.duration >= 60 ? `${task.duration / 60}h` : `${task.duration}m`}
                                    </Badge>
                                  )}
                                  {task.reminderMinutes !== null && task.reminderMinutes !== undefined && (
                                    <Badge variant="outline" className="gap-1 text-xs">
                                      <Bell className="h-3 w-3" />
                                      {task.reminderMinutes === 0 ? "At start" : `${task.reminderMinutes}m`}
                                    </Badge>
                                  )}
                                  {task.scheduledStart && (
                                    <Badge variant="secondary" className="gap-1">
                                      <Clock className="h-3 w-3" />
                                      {format(new Date(task.scheduledStart), "EEE dd.MM. HH:mm")}
                                    </Badge>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => startEditing(task)}
                                    data-testid={`button-edit-${task.id}`}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      )}
                    </Draggable>
                  ))}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
        )}
      </div>

      {completedTasks.length > 0 && (
        <Collapsible open={completedOpen} onOpenChange={setCompletedOpen}>
          <div className="flex items-center gap-2">
            <CollapsibleTrigger asChild>
              <Button 
                variant="ghost" 
                className="flex-1 justify-between px-4"
                data-testid="button-toggle-completed"
              >
                <span className="flex items-center gap-2">
                  Completed Tasks
                  <Badge variant="secondary" className="text-xs">
                    {completedTasks.length}
                  </Badge>
                </span>
                {completedOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
            </CollapsibleTrigger>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => deleteCompletedMutation.mutate()}
              disabled={deleteCompletedMutation.isPending}
              className="text-muted-foreground"
              data-testid="button-delete-completed"
            >
              {deleteCompletedMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" />
              )}
              Delete All
            </Button>
          </div>
          <CollapsibleContent className="space-y-2 mt-2">
            {completedTasks.map((task) => (
              <Card 
                key={task.id} 
                className="opacity-70"
                data-testid={`card-completed-${task.id}`}
              >
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={true}
                      disabled
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <span className="font-medium line-through text-muted-foreground">
                        {task.title}
                      </span>
                      {task.completedAt && (
                        <p className="text-xs text-muted-foreground mt-1">
                          Completed {format(new Date(task.completedAt), "EEE dd.MM. HH:mm")}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        completeTaskMutation.mutate({
                          id: task.id,
                          completed: false,
                        })
                      }
                      data-testid={`button-redo-${task.id}`}
                    >
                      <RotateCcw className="h-4 w-4 mr-1" />
                      Redo
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
