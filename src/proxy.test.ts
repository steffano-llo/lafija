import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy";

function request(path: string, cookie?: string) {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("proxy", () => {
  it("redirects signed-out visitors of the app to sign-in, keeping where they were going", () => {
    const response = proxy(request("/dashboard/board?view=all"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("next")).toBe("/dashboard/board?view=all");
  });

  it("lets requests with a session cookie through (the page verifies it)", () => {
    const response = proxy(request("/dashboard", "better-auth.session_token=abc.def"));

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("only runs on app routes", () => {
    expect(config.matcher).toEqual(["/dashboard/:path*"]);
  });
});
