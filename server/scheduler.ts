export type BusyInterval = {
  start: number
  end: number
}

type TimeSlot = {
  start: Date
  end: Date
}

export type SchedulingConfig = {
  timezone: string
  workStartHour: number
  workEndHour: number
}

type ScheduleTime = {
  hours: number
  minutes: number
  dayOfWeek: number
}

export type RescheduleSummary = {
  moved: number
  unchanged: number
  skippedNoSlot: number
  skippedInvalid: number
  failed: number
}

export function createEmptyRescheduleSummary(): RescheduleSummary {
  return {
    moved: 0,
    unchanged: 0,
    skippedNoSlot: 0,
    skippedInvalid: 0,
    failed: 0,
  }
}

export function getDurationMinutes(start: Date, end: Date): number | null {
  const diffMs = end.getTime() - start.getTime()
  if (!Number.isFinite(diffMs) || diffMs <= 0) {
    return null
  }
  return Math.round(diffMs / 60000)
}

function normalizeBusyIntervals(intervals: BusyInterval[]): BusyInterval[] {
  return intervals
    .filter(
      (interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end),
    )
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start)
}

function roundToNextQuarterHour(date: Date): Date {
  const rounded = new Date(date)
  rounded.setMinutes(Math.ceil(rounded.getMinutes() / 15) * 15)
  rounded.setSeconds(0)
  rounded.setMilliseconds(0)
  return rounded
}

function getTimeInTimezone(date: Date, timezone: string): ScheduleTime {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hour12: false,
  })

  const parts = formatter.formatToParts(date)
  const hours = parseInt(parts.find((part) => part.type === "hour")?.value || "0", 10)
  const minutes = parseInt(parts.find((part) => part.type === "minute")?.value || "0", 10)
  const weekday = parts.find((part) => part.type === "weekday")?.value || "Mon"
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  }

  return {
    hours,
    minutes,
    dayOfWeek: weekdayMap[weekday] ?? 1,
  }
}

function setToHourInTimezone(date: Date, hour: number, timezone: string): Date {
  const { hours: currentHours, minutes: currentMinutes } = getTimeInTimezone(
    date,
    timezone,
  )
  const currentTotalMinutes = currentHours * 60 + currentMinutes
  const targetTotalMinutes = hour * 60
  const diffMinutes = targetTotalMinutes - currentTotalMinutes

  const result = new Date(date)
  result.setMinutes(result.getMinutes() + diffMinutes)
  result.setSeconds(0)
  result.setMilliseconds(0)
  return result
}

function advanceToNextDayAtHour(date: Date, hour: number, timezone: string): Date {
  let result = setToHourInTimezone(date, hour, timezone)
  result.setTime(result.getTime() + 24 * 60 * 60 * 1000)
  const { hours } = getTimeInTimezone(result, timezone)
  if (hours !== hour) {
    result.setHours(result.getHours() + (hour - hours))
  }
  return result
}

export function findSlotFromBusyIntervals(
  busyIntervals: BusyInterval[],
  durationMinutes: number,
  config: SchedulingConfig,
  startTime: Date,
  searchEndDate: Date,
): TimeSlot | null {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return null
  }

  const sortedIntervals = normalizeBusyIntervals(busyIntervals)
  let intervalIndex = 0
  let currentDate = roundToNextQuarterHour(startTime)

  while (currentDate < searchEndDate) {
    const {
      hours: currentHour,
      minutes: currentMinute,
      dayOfWeek,
    } = getTimeInTimezone(currentDate, config.timezone)

    if (dayOfWeek === 0 || dayOfWeek === 6) {
      currentDate = advanceToNextDayAtHour(
        currentDate,
        config.workStartHour,
        config.timezone,
      )
      continue
    }

    const currentMinutes = currentHour * 60 + currentMinute
    const workStartMinutes = config.workStartHour * 60
    const workEndMinutes = config.workEndHour * 60

    if (currentMinutes < workStartMinutes) {
      currentDate = setToHourInTimezone(
        currentDate,
        config.workStartHour,
        config.timezone,
      )
      continue
    }

    if (currentMinutes + durationMinutes > workEndMinutes) {
      currentDate = advanceToNextDayAtHour(
        currentDate,
        config.workStartHour,
        config.timezone,
      )
      continue
    }

    const slotStart = new Date(currentDate)
    const slotEnd = new Date(slotStart)
    slotEnd.setMinutes(slotEnd.getMinutes() + durationMinutes)

    const slotStartMs = slotStart.getTime()
    const slotEndMs = slotEnd.getTime()

    while (
      intervalIndex < sortedIntervals.length &&
      sortedIntervals[intervalIndex].end <= slotStartMs
    ) {
      intervalIndex++
    }

    const overlappingInterval =
      intervalIndex < sortedIntervals.length &&
      sortedIntervals[intervalIndex].start < slotEndMs &&
      sortedIntervals[intervalIndex].end > slotStartMs
        ? sortedIntervals[intervalIndex]
        : null

    if (!overlappingInterval) {
      return { start: slotStart, end: slotEnd }
    }

    currentDate = roundToNextQuarterHour(new Date(overlappingInterval.end))
  }

  return null
}
