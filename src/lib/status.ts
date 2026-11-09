// Shared listing-status constants: labels, pill colours, and filters.
// Components import from here instead of hard-coding status strings.

export const STATUS = {
  available: "Available",
  inStock: "In stock",
  sold: "Sold",
  outOfStock: "Out of stock",
} as const;

export interface StatusMeta {
  label: string;
  /** Catppuccin Mocha colour used for the status pill text/dot. */
  color: string;
}

export const STATUS_META: Record<string, StatusMeta> = {
  [STATUS.available]: { label: STATUS.available, color: "#a6da95" },
  [STATUS.inStock]: { label: STATUS.inStock, color: "#89b4fa" },
  [STATUS.sold]: { label: STATUS.sold, color: "#f38ba8" },
  [STATUS.outOfStock]: { label: STATUS.outOfStock, color: "#f9e2af" },
};

export const ACTIVE_STATUSES: string[] = [STATUS.available, STATUS.inStock];

export type FilterId = "active" | "all" | "available" | "inStock" | "sold" | "outOfStock";

export interface FilterOption {
  id: FilterId;
  label: string;
}

export const FILTERS: FilterOption[] = [
  { id: "active", label: "Active" },
  { id: "all", label: "All" },
  { id: "available", label: STATUS.available },
  { id: "inStock", label: STATUS.inStock },
  { id: "sold", label: STATUS.sold },
  { id: "outOfStock", label: STATUS.outOfStock },
];

const FILTER_STATUS: Partial<Record<FilterId, string>> = {
  available: STATUS.available,
  inStock: STATUS.inStock,
  sold: STATUS.sold,
  outOfStock: STATUS.outOfStock,
};

export function matchesFilter(status: string, filter: FilterId): boolean {
  if (filter === "all") {
    return true;
  }
  if (filter === "active") {
    return ACTIVE_STATUSES.includes(status);
  }
  return status === FILTER_STATUS[filter];
}
