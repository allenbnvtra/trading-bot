export interface WalkForwardWindow {
  index: number;
  start: Date;
  end: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Foundation only: generates the (start, end) windows a future
 * walk-forward runner would iterate; this module does not run backtests or
 * make any pass/fail judgment. Deterministic and pure: identical inputs
 * always produce identical windows.
 */
export function generateWalkForwardWindows(
  totalStart: Date,
  totalEnd: Date,
  windowLengthDays: number,
  stepDays: number,
): WalkForwardWindow[] {
  if (windowLengthDays <= 0 || stepDays <= 0) {
    throw new Error("generateWalkForwardWindows: windowLengthDays and stepDays must both be positive");
  }
  if (totalEnd.getTime() <= totalStart.getTime()) {
    throw new Error("generateWalkForwardWindows: totalEnd must be after totalStart");
  }

  const windows: WalkForwardWindow[] = [];
  let windowStartMs = totalStart.getTime();
  let index = 0;

  while (windowStartMs + windowLengthDays * MS_PER_DAY <= totalEnd.getTime()) {
    const windowEndMs = windowStartMs + windowLengthDays * MS_PER_DAY;
    windows.push({ index, start: new Date(windowStartMs), end: new Date(windowEndMs) });
    windowStartMs += stepDays * MS_PER_DAY;
    index += 1;
  }

  return windows;
}
