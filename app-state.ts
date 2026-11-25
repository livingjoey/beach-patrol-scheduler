// Shared UI state and the re-render hook, kept separate from main.ts to avoid import cycles.
import { todayIso, weekStartOf } from '../../src/domain/dates.ts';

export const ui = {
  weekStart: weekStartOf(todayIso()),
};

let impl: (force?: boolean) => void = () => {};
export const setRerender = (fn: (force?: boolean) => void) => {
  impl = fn;
};
export const rerender = (force = false) => impl(force);
