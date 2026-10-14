import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DatePicker } from "./date-picker";

function Example({ initial = "2024-02-29", clearable = false }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <DatePicker
        label="日期"
        value={value}
        onValueChange={setValue}
        clearable={clearable}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

describe("DatePicker", () => {
  it("navigates across months with the keyboard and preserves local date values", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole("button", { name: "日期" }));
    const leapDay = screen.getByRole("button", { name: "2024-02-29" });
    await waitFor(() => expect(leapDay).toHaveFocus());
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "2024-03-01" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("2024-03-01");
    expect(screen.queryByRole("grid")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "日期" }),
    ).toHaveFocus();
  });

  it("clamps month navigation to valid days and handles year boundaries", async () => {
    const user = userEvent.setup();
    render(<Example initial="2024-01-31" />);
    await user.click(screen.getByRole("button", { name: "日期" }));
    await user.keyboard("{PageDown}");
    expect(screen.getByRole("button", { name: "2024-02-29" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, {
      key: "PageUp",
      shiftKey: true,
    });
    expect(screen.getByRole("button", { name: "2023-02-28" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("2023-02-28");
  });

  it("clears optional dates and closes with Escape without changing the value", async () => {
    const user = userEvent.setup();
    render(<Example clearable />);
    await user.click(screen.getByRole("button", { name: "日期" }));
    await user.keyboard("{ArrowLeft}{Escape}");
    expect(screen.getByTestId("value")).toHaveTextContent("2024-02-29");
    await user.click(screen.getByRole("button", { name: "日期" }));
    await user.click(screen.getByRole("button", { name: "清除" }));
    expect(screen.getByTestId("value")).toBeEmptyDOMElement();
    expect(
      screen.getByRole("button", { name: "日期" }),
    ).toHaveTextContent("选择日期");
  });

  it("keeps required dates and selects today using the local calendar date", async () => {
    const user = userEvent.setup();
    render(<Example />);
    await user.click(screen.getByRole("button", { name: "日期" }));
    expect(screen.getByRole("button", { name: "清除" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "今天" }));
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    expect(screen.getByTestId("value")).toHaveTextContent(today);
  });
});
