import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Brand } from "./SharedUi";

describe("Brand", () => {
  it("toggles its eyes and follows the pointer", async () => {
    const { container } = render(<Brand />);
    const logo = screen.getByRole("button", { name: "Show logo eyes" });
    const eyes = container.querySelector<SVGGElement>(".brand-eye-position");

    Object.defineProperty(logo, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 60, height: 100 }),
    });

    fireEvent.click(logo);
    expect(logo).toHaveAttribute("aria-pressed", "true");
    expect(logo).toHaveClass("is-awake");

    fireEvent.pointerMove(window, { clientX: 120, clientY: 50 });
    await waitFor(() => expect(eyes?.style.transform).not.toBe("translate(0px, 0px)"));

    fireEvent.click(logo);
    expect(logo).toHaveAttribute("aria-pressed", "false");
  });
});
