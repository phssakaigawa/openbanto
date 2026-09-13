import { describe, expect, it } from "vitest";
import { employeeUsableInChannel, employeeVisibleInChannel } from "../employee-access.js";

describe("employee-access (channel-scoped employees)", () => {
  const open = {};
  const scoped = { channels: ["C111", "C222"] };
  const hiddenOpen = { hidden: true };
  const hiddenScoped = { channels: ["C111"], hidden: true };

  it("no channels field → usable/visible everywhere", () => {
    expect(employeeUsableInChannel(open, "CANY")).toBe(true);
    expect(employeeUsableInChannel(open, undefined)).toBe(true);
    expect(employeeVisibleInChannel(open, undefined)).toBe(true);
  });

  it("channels set → usable only in listed channels", () => {
    expect(employeeUsableInChannel(scoped, "C111")).toBe(true);
    expect(employeeUsableInChannel(scoped, "C222")).toBe(true);
    expect(employeeUsableInChannel(scoped, "C999")).toBe(false);
  });

  it("channels set + no channel context (cron/web) → not usable", () => {
    expect(employeeUsableInChannel(scoped, undefined)).toBe(false);
    expect(employeeUsableInChannel(scoped, "")).toBe(false);
  });

  it("empty channels array behaves like unset (degrade open, not silent lockout)", () => {
    expect(employeeUsableInChannel({ channels: [] }, "CANY")).toBe(true);
  });

  it("visible follows usable for channel scoping", () => {
    expect(employeeVisibleInChannel(scoped, "C111")).toBe(true);
    expect(employeeVisibleInChannel(scoped, "C999")).toBe(false);
  });

  it("hidden → never visible, even where usable", () => {
    expect(employeeVisibleInChannel(hiddenOpen, "CANY")).toBe(false);
    expect(employeeVisibleInChannel(hiddenScoped, "C111")).toBe(false);
    expect(employeeUsableInChannel(hiddenScoped, "C111")).toBe(true);
  });
});
