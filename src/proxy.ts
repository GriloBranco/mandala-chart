import { NextResponse, type NextRequest } from "next/server";
import { readSession } from "@/server/auth";

// The welcome page and the account endpoints are open; everything else needs a session.
// This only checks the cookie's signature (no database). Route handlers do the full check.
const PUBLIC_PATHS = new Set(["/login", "/api/auth/config", "/api/auth/login", "/api/auth/signup", "/api/auth/logout"]);

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();
  if (await readSession(request.cookies)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  // Every view lives at "/" with a query (?g=..., ?report=1), so keep the query too.
  const target = pathname + search;
  if (target !== "/") login.searchParams.set("next", target);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    // Everything except Next internals and public files (icons, manifest, images).
    "/((?!_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest|sw.js|.*\\.(?:png|svg|ico|jpg|jpeg|webp|txt|xml|woff2?)$).*)",
  ],
};
