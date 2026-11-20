import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { CashflowProjectionChart } from "./CashflowProjectionChart";

it("exposes the active horizon and projection values through a native range", () => {
  render(<CashflowProjectionChart streams={[]} />);
  const week = screen.getByRole("button", { name: "7D" });
  fireEvent.click(week);
  expect(week).toHaveAttribute("aria-pressed", "true");
  const days = screen.getByRole("slider", { name: "Inspect projection day" });
  expect(days).toHaveAttribute("max", "7");
  fireEvent.change(days, { target: { value: "7" } });
  expect(days.getAttribute("aria-valuetext")).toContain("balance 0.0000");
  expect(screen.getByRole("img")).toHaveAccessibleName("Projected balance over time");
});
