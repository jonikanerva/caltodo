import { useState } from "react";
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
import { 
  Plus, 
  GripVertical, 
  ChevronDown, 
  ChevronUp, 
  RotateCcw, 
  Clock,
  AlertTriangle,
  Loader2,
  Settings
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Task, UserSettings } from "@shared/schema";
import { format } from "date-fns";

interface CreateTaskInput {
  title: string;
  details: string;
  urgent: boolean;
}

export default function MainPage() {
  const { toast } = useToast();
  const [newTask, setNewTask] = useState<CreateTaskInput>({
    title: "",
    details: "",
    urgent: false,
  });
  const [completedOpen, setCompletedOpen] = useState(false);

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
      setNewTask({ title: "", details: "", urgent: false });
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
      return apiRequest("PATCH", `/api/tasks/${id}`, { completed });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
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
                  Urgent (schedule first)
                </Label>
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
        <h2 className="text-lg font-semibold px-1">Tasks</h2>
        
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
            <Droppable droppableId="tasks">
              {(provided) => (
                <div
                  {...provided.droppableProps}
                  ref={provided.innerRef}
                  className="space-y-2"
                >
                  {uncompletedTasks.map((task, index) => (
                    <Draggable key={task.id} draggableId={task.id} index={index}>
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
                            <div className="flex items-start gap-3">
                              <div
                                {...provided.dragHandleProps}
                                className="mt-0.5 cursor-grab active:cursor-grabbing text-muted-foreground"
                              >
                                <GripVertical className="h-5 w-5" />
                              </div>
                              <Checkbox
                                checked={false}
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
                              {task.scheduledStart && (
                                <Badge variant="secondary" className="flex-shrink-0 gap-1">
                                  <Clock className="h-3 w-3" />
                                  {format(new Date(task.scheduledStart), "MMM d, h:mm a")}
                                </Badge>
                              )}
                            </div>
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
          <CollapsibleTrigger asChild>
            <Button 
              variant="ghost" 
              className="w-full justify-between px-4"
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
                          Completed {format(new Date(task.completedAt), "MMM d, h:mm a")}
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
