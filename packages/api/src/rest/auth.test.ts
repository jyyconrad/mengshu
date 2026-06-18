import { describe, expect, test } from "vitest";
import { authorizeRestRequest } from "./auth.js";

describe("REST auth guard", () => {
  test("allows loopback requests without a server secret", () => {
    expect(
      authorizeRestRequest({
        remoteAddress: "127.0.0.1",
        protocol: "http",
        headers: {},
        config: {},
      }),
    ).toEqual({ ok: true });
  });

  test("rejects non-loopback requests without a server secret", () => {
    expect(
      authorizeRestRequest({
        remoteAddress: "10.0.0.8",
        protocol: "http",
        headers: {},
        config: {},
      }),
    ).toEqual({ ok: false, status: 403, message: "REST API without secret is loopback-only" });
  });

  test("requires bearer token when server secret is configured", () => {
    expect(
      authorizeRestRequest({
        remoteAddress: "10.0.0.8",
        protocol: "https",
        headers: { authorization: "Bearer secret-token" },
        config: { secret: "secret-token" },
      }),
    ).toEqual({ ok: true });

    expect(
      authorizeRestRequest({
        remoteAddress: "127.0.0.1",
        protocol: "http",
        headers: { authorization: "Bearer wrong" },
        config: { secret: "secret-token" },
      }),
    ).toEqual({ ok: false, status: 401, message: "Invalid bearer token" });
  });

  test("rejects plaintext bearer when HTTPS is required", () => {
    expect(
      authorizeRestRequest({
        remoteAddress: "127.0.0.1",
        protocol: "http",
        headers: { authorization: "Bearer secret-token" },
        config: { secret: "secret-token", requireHttps: true },
      }),
    ).toEqual({ ok: false, status: 403, message: "HTTPS is required for REST API" });
  });
});
