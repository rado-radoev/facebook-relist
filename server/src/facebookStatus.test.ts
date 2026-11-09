import { describe, expect, it } from "vitest";
import { detectFacebookStatus, urlNeedsCheck } from "./facebookStatus.js";

const LOGIN_URL = "https://www.facebook.com/login";
const HOME_URL = "https://www.facebook.com/";

describe("detectFacebookStatus", () => {
  it("is connected whenever the c_user cookie is present", () => {
    const status = detectFacebookStatus({
      hasUserCookie: true,
      url: HOME_URL,
      previousStatus: "login_in_progress",
    });
    expect(status).toBe("connected");
  });

  it("does not treat a c_user cookie on a checkpoint page as connected", () => {
    expect(detectFacebookStatus({
      hasUserCookie: true,
      url: "https://www.facebook.com/checkpoint/approval/",
      previousStatus: "connected",
    })).toBe("needs_check");
  });

  it("stays login_in_progress on the login page without a cookie", () => {
    const status = detectFacebookStatus({
      hasUserCookie: false,
      url: LOGIN_URL,
      previousStatus: "login_in_progress",
    });
    expect(status).toBe("login_in_progress");
  });

  it("flags checkpoint and 2FA URLs as needs_check", () => {
    const checkpoint = detectFacebookStatus({
      hasUserCookie: false,
      url: "https://www.facebook.com/checkpoint/123456789/",
      previousStatus: "login_in_progress",
    });
    expect(checkpoint).toBe("needs_check");
    const twoFactor = detectFacebookStatus({
      hasUserCookie: false,
      url: "https://www.facebook.com/two_factor/ntp/",
      previousStatus: "login_in_progress",
    });
    expect(twoFactor).toBe("needs_check");
  });

  it("becomes expired when a connected session loses its cookie", () => {
    const status = detectFacebookStatus({
      hasUserCookie: false,
      url: LOGIN_URL,
      previousStatus: "connected",
    });
    expect(status).toBe("expired");
  });

  it("stays not_connected before any login attempt", () => {
    const status = detectFacebookStatus({
      hasUserCookie: false,
      url: LOGIN_URL,
      previousStatus: "not_connected",
    });
    expect(status).toBe("not_connected");
  });
});

describe("urlNeedsCheck", () => {
  it("does not flag ordinary pages", () => {
    expect(urlNeedsCheck(HOME_URL)).toBe(false);
    expect(urlNeedsCheck(LOGIN_URL)).toBe(false);
    expect(urlNeedsCheck("https://www.facebook.com/marketplace/")).toBe(false);
  });
});
