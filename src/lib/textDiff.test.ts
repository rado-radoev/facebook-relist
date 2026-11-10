import { describe, expect, it } from "vitest";
import { diffCapture } from "./textDiff";

describe("diffCapture", () => {
  it("append is a single insert of the new tail", () => {
    expect(diffCapture("abc", "abcd")).toEqual([{ type: "insert", text: "d" }]);
  });

  it("prepend is a single insert at the start", () => {
    expect(diffCapture("abc", "xabc")).toEqual([{ type: "insert", text: "x" }]);
  });

  it("backspace at the end is a single deleteBackward", () => {
    expect(diffCapture("abc", "ab")).toEqual([{ type: "deleteBackward", count: 1 }]);
  });

  it("deleting in the middle deletes only the removed character", () => {
    expect(diffCapture("abc", "ac")).toEqual([{ type: "deleteBackward", count: 1 }]);
  });

  it("replacing a selection is delete first, then insert", () => {
    expect(diffCapture("hello world", "hello there")).toEqual([
      { type: "deleteBackward", count: 5 },
      { type: "insert", text: "there" },
    ]);
  });

  it("paste is a single bulk insert", () => {
    expect(diffCapture("a", "a pasted chunk of text")).toEqual([
      { type: "insert", text: " pasted chunk of text" },
    ]);
    expect(diffCapture("", "pasted from scratch")).toEqual([
      { type: "insert", text: "pasted from scratch" },
    ]);
  });

  it("clearing the field deletes everything", () => {
    expect(diffCapture("abc", "")).toEqual([{ type: "deleteBackward", count: 3 }]);
  });

  it("no change is a no-op", () => {
    expect(diffCapture("abc", "abc")).toEqual([]);
    expect(diffCapture("", "")).toEqual([]);
  });
});
