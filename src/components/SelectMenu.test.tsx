import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

const options = [
  { value: "recorded", label: "Recorded" },
  { value: "added", label: "Date added" },
  { value: "modified", label: "File modified" },
] as const satisfies readonly SelectMenuOption<string>[];

function StatefulMenu() {
  const [value, setValue] = useState<(typeof options)[number]["value"]>("recorded");
  return (
    <SelectMenu
      ariaLabel="Date used to sort clips"
      onChange={setValue}
      options={options}
      value={value}
    />
  );
}

describe("SelectMenu", () => {
  it("selects an option with the pointer and exposes listbox state", () => {
    render(<StatefulMenu />);
    const trigger = screen.getByRole("combobox", { name: "Date used to sort clips" });

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "Date added" }));

    expect(trigger).toHaveTextContent("Date added");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("supports arrow, Home, End, Enter, and Escape keys", () => {
    render(<StatefulMenu />);
    const trigger = screen.getByRole("combobox", { name: "Date used to sort clips" });

    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "End" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveTextContent("File modified");

    fireEvent.keyDown(trigger, { key: "Home" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(trigger).toHaveTextContent("Recorded");

    fireEvent.keyDown(trigger, { key: " " });
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when focus or a pointer moves outside", () => {
    render(
      <div>
        <StatefulMenu />
        <button type="button">Outside</button>
      </div>,
    );
    const trigger = screen.getByRole("combobox", { name: "Date used to sort clips" });

    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.focusIn(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("skips disabled options", () => {
    const onChange = vi.fn();
    render(
      <SelectMenu
        ariaLabel="Example menu"
        onChange={onChange}
        options={[
          { value: "one", label: "One" },
          { value: "two", label: "Two", disabled: true },
          { value: "three", label: "Three" },
        ]}
        value="one"
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Example menu" });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "Two" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(trigger, { key: "Escape" });

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(trigger, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("three");
  });
});
