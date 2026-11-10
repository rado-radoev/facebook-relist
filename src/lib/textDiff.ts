// Pure diff between two captures of a text field.
//
// The live login view keeps a local capture of what the person has typed
// into the currently-focused remote field. When that capture changes we
// do not resend the whole string — we send the minimal edit, derived from
// the common prefix and common suffix of the old and new captures:
//
//   - characters removed from the middle/end become one
//     { type: "deleteBackward", count } op, and
//   - characters added become one { type: "insert", text } op.
//
// Delete comes first so a replace-selection replays as delete-then-insert
// in the remote field. No DOM, no state — just strings in, ops out.

export type CaptureOp =
  | { type: "deleteBackward"; count: number }
  | { type: "insert"; text: string };

export function diffCapture(prev: string, next: string): CaptureOp[] {
  if (prev === next) {
    return [];
  }

  let prefix = 0;
  const maxPrefix = Math.min(prev.length, next.length);
  while (prefix < maxPrefix && prev[prefix] === next[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  const maxSuffix = Math.min(prev.length - prefix, next.length - prefix);
  while (
    suffix < maxSuffix &&
    prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const deleted = prev.length - prefix - suffix;
  const inserted = next.slice(prefix, next.length - suffix);

  const ops: CaptureOp[] = [];
  if (deleted > 0) {
    ops.push({ type: "deleteBackward", count: deleted });
  }
  if (inserted.length > 0) {
    ops.push({ type: "insert", text: inserted });
  }
  return ops;
}
