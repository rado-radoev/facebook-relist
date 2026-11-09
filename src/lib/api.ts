// Relist backend API client. The backend derives the account from the
// httpOnly session cookie on every request — this client never sends an
// account id, and there is no endpoint that accepts one.

import type { SessionStatus } from "../types";

const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

export interface ApiUser {
  id: string;
  name: string;
  email: string;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return body as T;
}

export async function fetchMe(): Promise<ApiUser> {
  const data = await request<{ user: ApiUser }>("/api/auth/me");
  return data.user;
}

export async function login(email: string, password: string): Promise<ApiUser> {
  const data = await request<{ user: ApiUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return data.user;
}

export async function register(name: string, email: string, password: string): Promise<ApiUser> {
  const data = await request<{ user: ApiUser }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
  });
  return data.user;
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
  return `${API_BASE.replace(/^http/, "ws")}/api/facebook/view`;
}
