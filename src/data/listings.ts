import seed from "./preview-seed.json";
import type { Listing } from "../types";

export const listings = seed as Listing[];

export interface HistoryEntry {
  id: string;
  dateLabel: string;
  title: string;
  detail: string;
}

export const historyEntries: HistoryEntry[] = [
  {
    id: "hot-wheels-2026-10-12",
    dateLabel: "Oct 12, 2026",
    title: "Nintendo Switch Hot Wheels Unleashed 2 Turbocharged",
    detail:
      "Recreated like-for-like with all 3 photos. The old listing was deleted only after the new one went live.",
  },
];
