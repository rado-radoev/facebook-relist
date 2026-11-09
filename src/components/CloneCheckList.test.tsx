import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CloneCheckList, { buildCloneCheck, unresolvedApprovalRows } from "./CloneCheckList";
import type { Listing } from "../types";

const listing: Listing = {
  listing_id: "synthetic-listing",
  accountId: "synthetic-user",
  title: "Recovered title",
  price: "$10",
  condition: "Used - Good",
  description: "",
  location: "",
  status: "Available",
  creation_date: "",
  product_url: "https://example.invalid/item",
  photo: "blob:synthetic",
  photoCount: 2,
  photosDownloaded: 1,
  videoCount: 1,
  videoState: "present_not_downloaded",
  category: "Other",
  delivery: "Local pickup only",
  locationLabel: "",
  source: "synced",
  recoveryReasons: {
    description: "Facebook's edit form returned no description text.",
    location: "Listing Details had no location label.",
    photos: "Photo 2 failed download: HTTP 503.",
    video: "Video media request failed validation.",
  },
  videoReason: "Video media request failed validation.",
};

afterEach(() => cleanup());

describe("buildCloneCheck", () => {
  it("shows exact missing reasons and never marks unreadable fields or media green", () => {
    const rows = buildCloneCheck(listing);
    const byLabel = (label: string) => rows.find((row) => row.label === label);

    expect(byLabel("Description")?.state).toBe("missing");
    expect(byLabel("Description")?.value).toContain("Facebook's edit form returned no description text.");
    expect(byLabel("Location")?.state).toBe("missing");
    expect(byLabel("Location")?.value).toContain("Listing Details had no location label.");
    expect(byLabel("Photos")?.state).toBe("missing");
    expect(byLabel("Photos")?.value).toContain("Photo 2 failed download: HTTP 503.");
    expect(byLabel("Video")?.state).toBe("missing");
    expect(byLabel("Video")?.value).toContain("Video media request failed validation.");
  });

  it("shows an explicitly recovered empty attribute set as completed, not not-applicable", () => {
    const noAttributes: Listing = {
      ...listing,
      attributes: {},
      fieldStates: { attributes: "recovered" },
    };
    const row = buildCloneCheck(noAttributes).find((candidate) => candidate.label === "Attributes");
    expect(row?.state).toBe("ok");
    expect(row?.value).toMatch(/no attributes were present/i);
  });

  it("marks an archive photo that cannot be read as a missing photo, not a green recovered slot", () => {
    render(
      <CloneCheckList
        listing={{ ...listing, fieldStates: { photos: "recovered" } }}
        picks={{}}
        onPick={vi.fn()}
        overrides={{}}
        onOverride={vi.fn()}
        onDeliveryChoice={vi.fn()}
        photoTiles={[
          { id: "sha256-a.jpg", src: "blob:photo-a", label: "Photo 1", origin: "original" },
          { id: "sha256-b.jpg", src: null, label: "Photo 2 — archive read returned 404", origin: "original" },
        ]}
        photosEdited={false}
        onPhotoTilesChange={vi.fn()}
        canEditPhotos={false}
        canAddReplacePhotos={false}
        saveState="saved"
      />,
    );

    const photosRow = screen.getByText("Photos").closest("li");
    expect(photosRow?.className).toContain("check-missing");
    expect(photosRow?.textContent).toContain("Photo 2 — archive read returned 404");
    expect(photosRow?.textContent).not.toContain("✅");
  });

  it("clears an unknown field from approval only after a non-empty edit is supplied", () => {
    const unknownDescription: Listing = {
      ...listing,
      description: "",
      fieldStates: { description: "unknown" },
      recoveryReasons: { description: "The description control was unreadable." },
    };

    expect(unresolvedApprovalRows(unknownDescription, {}, {}).some((row) => row.label === "Description")).toBe(true);
    expect(unresolvedApprovalRows(unknownDescription, {}, { description: "Supplied after review" }).some((row) => row.label === "Description")).toBe(false);
    expect(unresolvedApprovalRows(unknownDescription, {}, { description: "" }).some((row) => row.label === "Description")).toBe(true);
  });

  it("keeps unknown video presence an unresolved, non-green approval", () => {
    const listingWithUnknownVideo: Listing = {
      ...listing,
      videoCount: 0,
      videoState: "unknown",
      videoPresence: "unknown",
      videoReason: "The listing surface did not reveal whether a video exists.",
      fieldStates: { video: "unknown" },
    };

    const video = buildCloneCheck(listingWithUnknownVideo).find((row) => row.label === "Video");
    expect(video?.state).toBe("unknown");
    expect(video?.value).toContain("The listing surface did not reveal whether a video exists.");
    expect(unresolvedApprovalRows(listingWithUnknownVideo, {}).some((row) => row.label === "Video")).toBe(true);
  });

  it("does not treat a field's saved pick as unresolved approval", () => {
    const unresolved = unresolvedApprovalRows(listing, {
      condition: "Used - Good",
      category: "Other",
    });

    expect(unresolved.some((row) => row.label === "Condition")).toBe(false);
    expect(unresolved.some((row) => row.label === "Category")).toBe(false);
    expect(unresolved.some((row) => row.label === "Photos")).toBe(true);
  });

  it("allows a missing-field pick to be edited after it has been selected", () => {
    const onPick = vi.fn();
    render(
      <CloneCheckList
        listing={{ ...listing, conditionFlag: "Condition is blank" }}
        picks={{ condition: "Used - Like New" }}
        onPick={onPick}
        overrides={{}}
        onOverride={vi.fn()}
        onDeliveryChoice={vi.fn()}
        photoTiles={[]}
        photosEdited={false}
        onPhotoTilesChange={vi.fn()}
        canEditPhotos={false}
        canAddReplacePhotos={false}
        saveState="saved"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit pick" }));
    fireEvent.click(screen.getByRole("button", { name: "Used – Good" }));
    expect(onPick).toHaveBeenCalledWith("condition", "Used – Good");
  });

  it("sends a structured delivery choice through onDeliveryChoice", () => {
    const onDeliveryChoice = vi.fn();
    render(
      <CloneCheckList
        listing={{
          ...listing,
          deliveryInfo: {
            type: "Local pickup only",
            shipping: null,
            meetup: { public: null, doorPickup: null, doorDropoff: null },
          },
        }}
        picks={{}}
        onPick={vi.fn()}
        overrides={{}}
        onOverride={vi.fn()}
        onDeliveryChoice={onDeliveryChoice}
        photoTiles={[]}
        photosEdited={false}
        onPhotoTilesChange={vi.fn()}
        canEditPhotos={false}
        canAddReplacePhotos={false}
        saveState="saved"
      />,
    );

    const shippingRow = screen.getByText("Shipping").closest("li") as HTMLElement;
    fireEvent.click(within(shippingRow).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(shippingRow).getByRole("button", { name: "Yes" }));
    expect(onDeliveryChoice).toHaveBeenCalledWith("shipping", true);

    const doorPickupRow = screen.getByText("Door pickup").closest("li") as HTMLElement;
    fireEvent.click(within(doorPickupRow).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(doorPickupRow).getByRole("button", { name: "No" }));
    expect(onDeliveryChoice).toHaveBeenCalledWith("doorPickup", false);
  });
});
