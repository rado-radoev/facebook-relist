// Selectable options for fields the clone check could not recover.
//
// Product rule (hers, 2026-11-09): a missing field is NEVER shown as just
// a warning. The clone preview offers the field's real options inline, the
// person picks one, Recreate stays blocked until they do, and the pick is
// saved per listing.
//
// Condition values are Facebook's actual condition values. Category and
// delivery lists are preview stand-ins: Sprint 2 replaces them with the
// options Facebook itself offers for the listing (its category picker and
// delivery step), keeping this same pick-to-unblock behaviour.

export type PickableField = "condition" | "category" | "delivery";

export const CONDITION_OPTIONS: string[] = [
  "New",
  "Used – Like New",
  "Used – Good",
  "Used – Fair",
];

export const CATEGORY_OPTIONS: string[] = [
  "Toys & Games",
  "Video Games",
  "Keyboards & Keypads",
  "Electronics",
  "Home & Garden",
  "Clothing & Accessories",
  "Sports & Outdoors",
  "Other",
];

export const DELIVERY_OPTIONS: string[] = [
  "Local pickup only",
  "Public meetup",
  "Door pickup",
  "Door dropoff",
  "Shipping",
];

export const FIELD_OPTIONS: Record<PickableField, string[]> = {
  condition: CONDITION_OPTIONS,
  category: CATEGORY_OPTIONS,
  delivery: DELIVERY_OPTIONS,
};

export type FieldPicks = Partial<Record<PickableField, string>>;
