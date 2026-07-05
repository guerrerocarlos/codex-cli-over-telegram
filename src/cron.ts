export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

const CRON_FIELD_RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

export function validateCronExpression(expression: string): string {
  const normalized = normalizeCronExpression(expression);
  parseCronExpression(normalized);
  return normalized;
}

export function normalizeCronExpression(expression: string): string {
  return expression.trim().split(/\s+/).join(" ");
}

export function parseCronExpression(expression: string): ParsedCron {
  const fields = normalizeCronExpression(expression).split(" ");
  if (fields.length !== 5) {
    throw new Error("Cron expression must contain exactly 5 fields: minute hour day month weekday.");
  }

  const minutes = parseCronField(fields[0] ?? "", 0, 59, false);
  const hours = parseCronField(fields[1] ?? "", 0, 23, false);
  const daysOfMonth = parseCronField(fields[2] ?? "", 1, 31, false);
  const months = parseCronField(fields[3] ?? "", 1, 12, false);
  const daysOfWeek = parseCronField(fields[4] ?? "", 0, 7, true);

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

export function nextCronRunAfter(expression: string, after: Date): Date {
  const parsed = parseCronExpression(expression);
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxMinutes = 366 * 24 * 60;
  for (let i = 0; i < maxMinutes; i += 1) {
    if (cronMatches(parsed, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error("Could not find the next cron run within one year.");
}

function parseCronField(field: string, min: number, max: number, normalizeSevenToZero: boolean): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error(`Invalid empty cron field part in "${field}".`);
    }
    addCronPart(values, trimmed, min, max, normalizeSevenToZero);
  }
  return values;
}

function addCronPart(values: Set<number>, part: string, min: number, max: number, normalizeSevenToZero: boolean): void {
  const [rangePart, stepPart] = part.split("/");
  if (!rangePart || part.split("/").length > 2) {
    throw new Error(`Invalid cron field part: ${part}`);
  }

  const step = stepPart === undefined ? 1 : Number(stepPart);
  if (!Number.isSafeInteger(step) || step <= 0) {
    throw new Error(`Invalid cron step in "${part}".`);
  }

  const [start, end] = parseCronRange(rangePart, min, max);
  for (let value = start; value <= end; value += step) {
    values.add(normalizeSevenToZero && value === 7 ? 0 : value);
  }
}

function parseCronRange(rangePart: string, min: number, max: number): [number, number] {
  if (rangePart === "*") {
    return [min, max];
  }

  const pieces = rangePart.split("-");
  if (pieces.length === 1) {
    const value = parseCronNumber(pieces[0] ?? "", min, max);
    return [value, value];
  }
  if (pieces.length === 2) {
    const start = parseCronNumber(pieces[0] ?? "", min, max);
    const end = parseCronNumber(pieces[1] ?? "", min, max);
    if (start > end) {
      throw new Error(`Invalid descending cron range: ${rangePart}`);
    }
    return [start, end];
  }

  throw new Error(`Invalid cron range: ${rangePart}`);
}

function parseCronNumber(value: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Cron value "${value}" must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function cronMatches(parsed: ParsedCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();
  const dayOfMonthMatches = parsed.daysOfMonth.has(dayOfMonth);
  const dayOfWeekMatches = parsed.daysOfWeek.has(dayOfWeek);
  const dayOfMonthIsWildcard = parsed.daysOfMonth.size === 31;
  const dayOfWeekIsWildcard = parsed.daysOfWeek.size === 7;
  const dayMatches =
    dayOfMonthIsWildcard && dayOfWeekIsWildcard
      ? true
      : dayOfMonthIsWildcard
        ? dayOfWeekMatches
        : dayOfWeekIsWildcard
          ? dayOfMonthMatches
          : dayOfMonthMatches || dayOfWeekMatches;

  return (
    parsed.minutes.has(minute) &&
    parsed.hours.has(hour) &&
    dayMatches &&
    parsed.months.has(month)
  );
}
