import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PhotoEditor from "./PhotoEditor";
import type { PhotoTile } from "../lib/photos";

const tiles: PhotoTile[] = [
  { id: "sha256-a", src: "blob:a", label: "Photo A", origin: "original" },
  { id: "sha256-b", src: "blob:b", label: "Photo B", origin: "original" },
];

afterEach(cleanup);

describe("PhotoEditor ordering", () => {
  it("moves a selected photo without changing its immutable archive identity", () => {
    const onChange = vi.fn();
    render(<PhotoEditor tiles={tiles} onChange={onChange} />);

    const photoB = screen.getByAltText("Photo B").closest(".photo-tile");
    expect(photoB).not.toBeNull();
    fireEvent.click(within(photoB as HTMLElement).getByRole("button", { name: "Move Photo B up" }));

    expect(onChange).toHaveBeenCalledWith([tiles[1], tiles[0]]);
  });
});
