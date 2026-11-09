import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";

describe("password hashing (scrypt)", () => {
  it("verifies a correct password against its hash", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("scrypt:")).toBe(true);
    await expect(verifyPassword("correct horse battery", stored)).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery");
    await expect(verifyPassword("wrong password", stored)).resolves.toBe(false);
  });

  it("produces different hashes for the same password (random salt)", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first).not.toBe(second);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    await expect(verifyPassword("whatever", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("whatever", "scrypt:x:y:z:AA:BB")).resolves.toBe(false);
  });
});
