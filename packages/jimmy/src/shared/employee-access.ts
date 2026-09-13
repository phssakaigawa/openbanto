import type { Employee } from "./types.js";

/**
 * Channel-scoped employee access (see Employee.channels / Employee.hidden).
 *
 * "Usable" gates execution: routing (@-mention / image), delegation via
 * POST /api/sessions, and cron. "Visible" additionally honors `hidden` and
 * gates the org roster shown to the LLM, so a channel-scoped employee's
 * existence does not leak outside its channels.
 */

export function employeeUsableInChannel(emp: Pick<Employee, "channels">, channel?: string): boolean {
  if (!emp.channels || emp.channels.length === 0) return true;
  return !!channel && emp.channels.includes(channel);
}

export function employeeVisibleInChannel(emp: Pick<Employee, "channels" | "hidden">, channel?: string): boolean {
  if (emp.hidden) return false;
  return employeeUsableInChannel(emp, channel);
}
