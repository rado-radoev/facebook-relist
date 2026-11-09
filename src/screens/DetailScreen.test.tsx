import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Listing, StoredClone } from "../types";
import DetailScreen from "./DetailScreen";

const api = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    status = 0;
    details: Record<string, unknown> = {};
  },
  createJob: vi.fn(),
  fetchArchivedPhotoUrl: vi.fn(),
  fetchClone: vi.fn(),
  recoverClone: vi.fn(),
  saveClonePicks: vi.fn(),
}));

vi.mock("../lib/api", () => api);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const listing: Listing = {
  listing_id: "listing-1",
  accountId: "user-1",
  title: "Recovered title",
  price: "$10",
  condition: "",
  description: "Recovered description",
  location: "San Diego",
  status: "Available",
  creation_date: "",
  product_url: "https://example.invalid/item",
  photo: "/photo.jpg",
  photoCount: null,
  videoCount: 0,
  category: null,
  conditionFlag: null,
  delivery: null,
  locationLabel: "San Diego",
  source: "synced",
};

const stored: StoredClone = {
  recovery: {
    listingId: "listing-1",
    recoveredAt: "2026-11-09T00:00:00Z",
    title: { value: "Recovered title", source: "edit_form", reason: null },
    price: { value: "$10", source: "edit_form", reason: null },
    description: { value: "Recovered description", source: "edit_form", reason: null },
    category: { value: "Other", source: "edit_form", reason: null },
    condition: { value: null, source: null, reason: "Condition is blank in the edit form." },
    attributes: { value: {}, source: "edit_form", reason: null },
    location: { value: "San Diego", source: "edit_form", reason: null },
    delivery: {
      value: { type: "Local pickup only", shipping: false, meetup: { public: false, doorPickup: false, doorDropoff: false } },
      source: "edit_form",
      reason: null,
    },
    photos: { urls: ["https://example.invalid/photo"], files: ["photo-1.jpg"], downloaded: 1 },
    video: { present: false, state: "none", file: null, reason: null },
    step2Blocked: false,
  },
  picks: {},
  edits: {},
  photoSelection: null,
  updatedAt: "2026-11-09T00:00:00Z",
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DetailScreen persistence", () => {
  it("persists reordered media and starts a job with the saved selection", async () => {
    const completeClone: StoredClone = {
      ...stored,
      recovery: {
        ...stored.recovery!,
        title: { value: "Recovered title", source: "edit_form", state: "recovered", reason: null },
        price: { value: "$10", source: "edit_form", state: "recovered", reason: null },
        description: { value: "Recovered description", source: "edit_form", state: "recovered", reason: null },
        category: { value: "Other", source: "edit_form", state: "recovered", reason: null },
        condition: { value: "Used - Good", source: "edit_form", state: "recovered", reason: null },
        attributes: { value: {}, source: "edit_form", state: "recovered", reason: null },
        location: { value: "San Diego", source: "edit_form", state: "recovered", reason: null },
        delivery: {
          value: { type: "Local pickup only", shipping: false, meetup: { public: false, doorPickup: false, doorDropoff: false } },
          source: "edit_form",
          state: "recovered",
          reason: null,
        },
        photos: {
          urls: ["https://example.invalid/one", "https://example.invalid/two"],
          files: ["photo-1.jpg", "photo-2.jpg"],
          downloaded: 2,
          expectedCount: 2,
          complete: true,
          identities: ["sha256-one", "sha256-two"],
          reasons: [null, null],
        },
        video: { present: false, state: "none", file: null, reason: null },
      },
      photoSelection: null,
    };
    api.fetchClone.mockResolvedValue(completeClone);
    api.createJob.mockResolvedValue({ id: "job-1" });
    api.fetchArchivedPhotoUrl.mockImplementation(async (_listingId: string, index: number) => `blob:photo-${index}`);
    api.saveClonePicks.mockImplementation(async (_listingId, input) => ({
      ...completeClone,
      picks: input.picks,
      edits: input.edits,
      photoSelection: input.photoSelection,
    }));

    render(
      <DetailScreen
        listing={listing}
        facebookConnected
        onBack={vi.fn()}
        onRecreate={vi.fn()}
      />,
    );

    expect(await screen.findByText("Photos")).toBeTruthy();
    const photosRow = screen.getByText("Photos").closest("li");
    expect(photosRow).not.toBeNull();
    fireEvent.click(within(photosRow as HTMLElement).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Move Photo 2 up" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Move Photo 1 down" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move Photo 2 up" }));

    await waitFor(() => expect(api.saveClonePicks).toHaveBeenCalledWith("listing-1", expect.objectContaining({
      photoSelection: ["photo-2.jpg", "photo-1.jpg"],
    })));
    const recreate = screen.getByRole("button", { name: "Recreate listing" });
    await waitFor(() => expect(recreate.hasAttribute("disabled")).toBe(false));
    fireEvent.click(recreate);
    await waitFor(() => expect(api.createJob).toHaveBeenCalledWith("listing-1", 0));
  });

  it("surfaces a clone-changed conflict instead of starting the recreate", async () => {
    const completeClone: StoredClone = {
      ...stored,
      recovery: {
        ...stored.recovery!,
        condition: { value: "Used - Good", source: "edit_form", reason: null },
        photos: {
          urls: ["https://example.invalid/photo"],
          files: ["photo-1.jpg"],
          downloaded: 1,
          expectedCount: 1,
          complete: true,
          identities: ["sha256-one"],
          reasons: [null],
        },
      },
      revision: 3,
    };
    api.fetchClone.mockResolvedValue(completeClone);
    api.fetchArchivedPhotoUrl.mockResolvedValue("blob:archived-photo");
    api.saveClonePicks.mockImplementation(async (_listingId, input) => ({ ...completeClone, ...input }));
    const conflict = new api.ApiError("The clone check changed after acknowledgement; save the current version before recreating.");
    conflict.status = 409;
    api.createJob.mockRejectedValue(conflict);
    const onRecreate = vi.fn();

    render(<DetailScreen listing={listing} facebookConnected onBack={vi.fn()} onRecreate={onRecreate} />);

    const recreate = await screen.findByRole("button", { name: "Recreate listing" });
    await waitFor(() => expect(recreate.hasAttribute("disabled")).toBe(false));
    fireEvent.click(recreate);
    expect(await screen.findByText(/clone check changed after acknowledgement/i)).toBeTruthy();
    expect(api.createJob).toHaveBeenCalledWith("listing-1", 3);
    expect(onRecreate).not.toHaveBeenCalled();
  });

  it("offers a pick when a field is explicitly unknown", async () => {
    const unknownCondition: StoredClone = {
      ...stored,
      recovery: {
        ...stored.recovery!,
        category: { value: null, source: null, state: "unknown", reason: "The source did not expose category." },
      },
    };
    api.fetchClone.mockResolvedValue(unknownCondition);
    api.fetchArchivedPhotoUrl.mockResolvedValue("blob:archived-photo");
    api.saveClonePicks.mockImplementation(async (_listingId, input) => ({
      ...unknownCondition,
      picks: input.picks,
      edits: input.edits,
      photoSelection: input.photoSelection,
    }));

    render(<DetailScreen listing={listing} facebookConnected onBack={vi.fn()} onRecreate={vi.fn()} />);

    expect(await screen.findByText("The source did not expose category.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Toys & Games" }));
    await waitFor(() => expect(api.saveClonePicks).toHaveBeenCalledWith("listing-1", expect.objectContaining({
      picks: expect.objectContaining({ category: "Toys & Games" }),
    })));
  });

  it("edits shipping as a structured saved choice", async () => {
    api.fetchClone.mockResolvedValue(stored);
    api.fetchArchivedPhotoUrl.mockResolvedValue("blob:archived-photo");
    api.saveClonePicks.mockImplementation(async (_listingId, input) => ({ ...stored, ...input }));

    render(<DetailScreen listing={listing} facebookConnected onBack={vi.fn()} onRecreate={vi.fn()} />);

    const shippingRow = (await screen.findByText("Shipping")).closest("li");
    expect(shippingRow).not.toBeNull();
    fireEvent.click(within(shippingRow as HTMLElement).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(shippingRow as HTMLElement).getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(api.saveClonePicks).toHaveBeenCalledWith("listing-1", expect.objectContaining({
      deliveryEdits: expect.objectContaining({ shipping: true }),
    })));
  });

  it("reloads selected archive photos in the exact saved order", async () => {
    const selectedClone: StoredClone = {
      ...stored,
      recovery: {
        ...stored.recovery!,
        condition: { value: "New", source: "edit_form", reason: null },
        delivery: {
          value: { type: "Local pickup only", shipping: false, meetup: { public: false, doorPickup: false, doorDropoff: false } },
          source: "edit_form",
          reason: null,
        },
        photos: {
          urls: ["https://example.invalid/one", "https://example.invalid/two"],
          files: ["photo-1.jpg", "photo-2.jpg"],
          downloaded: 2,
        },
      },
      photoSelection: ["photo-2.jpg", "photo-1.jpg"],
      picks: { condition: "New" },
    };
    api.fetchClone.mockResolvedValue(selectedClone);
    api.fetchArchivedPhotoUrl.mockImplementation(async (_listingId: string, index: number) => `blob:photo-${index}`);
    api.saveClonePicks.mockResolvedValue(selectedClone);

    render(
      <DetailScreen
        listing={listing}
        facebookConnected
        onBack={vi.fn()}
        onRecreate={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.fetchArchivedPhotoUrl).toHaveBeenCalledTimes(2));
    expect(api.fetchArchivedPhotoUrl.mock.calls.map((call) => call[1])).toEqual([1, 0]);
  });

  it("blocks recreate when a present Facebook video was not downloaded", async () => {
    const videoClone: StoredClone = {
      ...stored,
      recovery: {
        ...stored.recovery!,
        condition: { value: "New", source: "edit_form", reason: null },
        delivery: {
          value: { type: "Local pickup only", shipping: false, meetup: { public: false, doorPickup: false, doorDropoff: false } },
          source: "edit_form",
          reason: null,
        },
        video: { present: true, state: "present_not_downloaded", file: null, reason: "The test archive has no validated video file." },
      },
      picks: { condition: "New" },
    };
    api.fetchClone.mockResolvedValue(videoClone);
    api.fetchArchivedPhotoUrl.mockResolvedValue("blob:archived-photo");
    api.saveClonePicks.mockResolvedValue(videoClone);

    render(
      <DetailScreen
        listing={{ ...listing, videoCount: 1 }}
        facebookConnected
        onBack={vi.fn()}
        onRecreate={vi.fn()}
      />,
    );

    expect(await screen.findByText("The test archive has no validated video file.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/saved for this listing/i)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Recreate listing" }).hasAttribute("disabled")).toBe(true);
  });

  it("retries a failed clone save and waits for the server acknowledgement before allowing recreate", async () => {
    const failedSave = new Error("synthetic persistence failure");
    api.fetchClone.mockResolvedValue(stored);
    api.fetchArchivedPhotoUrl.mockResolvedValue("blob:archived-photo");
    api.saveClonePicks.mockRejectedValueOnce(failedSave).mockResolvedValue(stored);

    render(
      <DetailScreen
        listing={listing}
        facebookConnected
        onBack={vi.fn()}
        onRecreate={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    const recreate = screen.getByRole("button", { name: "Recreate listing" });
    expect(recreate.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    await waitFor(() => expect(screen.getByText(/confirmed saved for this listing/i)).toBeTruthy());
    expect(api.saveClonePicks).toHaveBeenCalledTimes(2);
  });

  it("does not claim an unsaved pick is saved while persistence is pending", async () => {
    const archive = deferred<string>();
    const save = deferred<{ clone: StoredClone }>();
    api.fetchClone.mockResolvedValue(stored);
    api.fetchArchivedPhotoUrl.mockReturnValue(archive.promise);
    api.saveClonePicks.mockReturnValue(save.promise);

    render(
      <DetailScreen
        listing={listing}
        facebookConnected
        onBack={vi.fn()}
        onRecreate={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Used – Like New" }));
    archive.resolve("blob:archived-photo");
    await waitFor(() => expect(api.saveClonePicks).toHaveBeenCalled());

    expect(screen.queryByText(/your pick — saved for this listing/i)).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/saving your picks/i);
  });
});
