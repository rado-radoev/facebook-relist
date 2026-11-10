// Relist backend API client. The backend derives the account from the
// httpOnly session cookie on every request — this client never sends an
// account id, and there is no endpoint that accepts one.

import type {
  CloneEdits,
  ClonePicks,
  DeliveryEdits,
  JobHistoryEntry,
  RecreateJob,
  SessionStatus,
  StoredClone,
  SyncedListing,
} from "../types";

const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

/** Use the app origin in production; Vite proxies same-origin /api calls in development. */
function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export interface ApiUser {
  id: string;
  name: string;
  email: string;
}

export class ApiError extends Error {
  status: number;
  /** The parsed error body, for structured fields (e.g. a job creation
   *  conflict carries the active job's id; an incomplete clone carries
   *  the missing field names). */
  details: Record<string, unknown>;

  constructor(status: number, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Claim a JSON content type only when a body is actually sent. A
  // body-less POST sent with "Content-Type: application/json" makes
  // strict JSON parsers reject the request before it reaches a route
  // (the backend also tolerates it now — this is belt and braces).
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body != null && headers["Content-Type"] === undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}

/**
 * A 200 response is not proof of a usable payload: a misconfigured proxy
 * in front of the app can answer 200 with an HTML fallback page, which
 * request() parses to {}. Auth helpers must reject that like any other
 * auth failure — otherwise callers store an undefined user and the
 * render path crashes reading its fields.
 */
function isApiUser(value: unknown): value is ApiUser {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const user = value as Record<string, unknown>;
  return typeof user.id === "string" && typeof user.name === "string" && typeof user.email === "string";
}

function requireApiUser(data: { user?: unknown }): ApiUser {
  if (!isApiUser(data.user)) {
    throw new ApiError(502, "Unexpected response from the server: the auth payload has no user.");
  }
  return data.user;
}

export async function fetchMe(): Promise<ApiUser> {
  const data = await request<{ user?: unknown }>("/api/auth/me");
  return requireApiUser(data);
}

export async function login(email: string, password: string): Promise<ApiUser> {
  const data = await request<{ user?: unknown }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return requireApiUser(data);
}

export async function register(name: string, email: string, password: string): Promise<ApiUser> {
  const data = await request<{ user?: unknown }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });
  return requireApiUser(data);
}

export async function logout(): Promise<void> {
  await request("/api/auth/logout", { method: "POST" });
}

export async function fetchFacebookStatus(): Promise<SessionStatus> {
  const data = await request<{ status: SessionStatus }>("/api/facebook/status");
  return data.status;
}

export async function connectFacebook(): Promise<SessionStatus> {
  const data = await request<{ status: SessionStatus }>("/api/facebook/connect", {
    method: "POST",
  });
  return data.status;
}

export async function disconnectFacebook(): Promise<SessionStatus> {
  const data = await request<{ status: SessionStatus }>("/api/facebook/disconnect", {
    method: "POST",
  });
  return data.status;
}

/** WebSocket URL for the live remote view of the backend browser. */
export function facebookViewSocketUrl(): string {
  const base = API_BASE || window.location.origin;
  return `${base.replace(/^http/, "ws")}/api/facebook/view`;
}

// ---------------------------------------------------------------------------
// Sprint 2: listings sync + clone recovery

export interface ListingsResponse {
  listings: SyncedListing[];
  syncedAt: string | null;
}

export async function fetchListings(): Promise<ListingsResponse> {
  return request<ListingsResponse>("/api/listings");
}

export async function syncListings(): Promise<ListingsResponse> {
  return request<ListingsResponse>("/api/listings/sync", { method: "POST" });
}

/** The stored clone check for a listing, or null when none exists yet. */
export async function fetchClone(listingId: string): Promise<StoredClone | null> {
  try {
    const data = await request<{ clone: StoredClone }>(`/api/listings/${listingId}/clone`);
    return data.clone;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function recoverClone(listingId: string): Promise<StoredClone> {
  const data = await request<{ clone: StoredClone }>(`/api/listings/${listingId}/clone/recover`, {
    method: "POST",
  });
  return data.clone;
}

export async function saveClonePicks(
  listingId: string,
  input: { picks: ClonePicks; edits: CloneEdits; deliveryEdits?: DeliveryEdits; photoSelection: string[] | null; revision?: number },
): Promise<StoredClone> {
  const data = await request<{ clone: StoredClone }>(`/api/listings/${listingId}/clone/picks`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return data.clone;
}

// ---------------------------------------------------------------------------
// Sprint 3: recreate jobs + history

/** Start a recreate job for one of the person's own synced listings.
 *  The backend refuses (400) while any clone field is still missing,
 *  and (409) while another job is active for the account. */
export async function createJob(listingId: string, revision?: number): Promise<RecreateJob> {
  const data = await request<{ job: RecreateJob }>(`/api/listings/${listingId}/jobs`, {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
  return data.job;
}

export async function fetchJobs(): Promise<RecreateJob[]> {
  const data = await request<{ jobs: RecreateJob[] }>("/api/jobs");
  return data.jobs;
}

export async function fetchJob(jobId: string): Promise<RecreateJob> {
  const data = await request<{ job: RecreateJob }>(`/api/jobs/${jobId}`);
  return data.job;
}

export async function fetchJobHistory(): Promise<JobHistoryEntry[]> {
  const data = await request<{ history?: unknown }>("/api/history");
  if (!Array.isArray(data.history)) {
    // HistoryScreen reads .length/.map on this value during render,
    // outside any try/catch — an undefined here would crash the screen
    // the same way an undefined auth user crashed the app shell.
    throw new ApiError(502, "Unexpected response from the server: the history payload is not a list.");
  }
  return data.history as JobHistoryEntry[];
}

/**
 * An archived photo as an object URL. The photo endpoint is behind the
 * session cookie, and a cross-origin <img> would not send it — so the
 * bytes are fetched with credentials and wrapped in a blob URL.
 */
export async function fetchArchivedPhotoUrl(listingId: string, index: number): Promise<string> {
  const response = await fetch(`${API_BASE}/api/listings/${listingId}/photos/${index}`, {
    credentials: "include",
  });
  if (!response.ok) {
    throw new ApiError(response.status, `Photo request failed (${response.status})`);
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
