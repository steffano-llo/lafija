import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

// Resolve the auth instance per request so the build never needs runtime secrets.
function handler(request: Request) {
  const handlers = toNextJsHandler(getAuth());
  return request.method === "POST" ? handlers.POST(request) : handlers.GET(request);
}

export { handler as GET, handler as POST };
