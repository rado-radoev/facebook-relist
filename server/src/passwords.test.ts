import { describe, expect, it } from "vitest";
import { hashPassword, needsPasswordRehash, verifyPassword } from "./passwords.js";

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

  it("uses the measured stronger scrypt profile and bounds input length", async () => {
    const stored = await hashPassword("synthetic-password");
    expect(stored.split(":").slice(1, 4)).toEqual(["16384", "8", "5"]);
    await expect(hashPassword("x".repeat(1025))).rejects.toThrow(/maximum/i);
  });

  it("identifies legacy parameters for rehash after a successful login", async () => {
    const { scrypt } = await import("node:crypto");
    const salt = Buffer.alloc(16, 7);
    const legacyKey = await new Promise<Buffer>((resolve, reject) => {
      scrypt("legacy-password", salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
        error ? reject(error) : resolve(key as Buffer),
      );
    });
    const legacy = ["scrypt", "16384", "8", "1", salt.toString("base64"), legacyKey.toString("base64")].join(":");
    expect(await verifyPassword("legacy-password", legacy)).toBe(true);
    expect(needsPasswordRehash(legacy)).toBe(true);
  });

  it("rejects malformed stored hashes instead of throwing", async () => {
    await expect(verifyPassword("whatever", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("whatever", "scrypt:x:y:z:AA:BB")).resolves.toBe(false);
  });
});
