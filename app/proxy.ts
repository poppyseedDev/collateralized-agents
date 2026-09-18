import { NextResponse, type NextRequest } from "next/server";

/**
 * Host-based routing for one deployment:
 *   proofofagent.dev       -> the one-pager (landing + waitlist); app paths redirect to the dev host
 *   dev.proofofagent.dev   -> the app; the landing redirects to the public site
 *   localhost / previews   -> everything, landing at /landing
 */
const SITE_HOSTS = new Set(["proofofagent.dev", "www.proofofagent.dev"]);
const APP_HOST = "dev.proofofagent.dev";
const SITE_ORIGIN = "https://proofofagent.dev";
const APP_ORIGIN = `https://${APP_HOST}`;

export default function proxy(req: NextRequest) {
  const host = req.headers.get("host")?.split(":")[0] ?? "";
  const { pathname, search } = req.nextUrl;

  if (SITE_HOSTS.has(host)) {
    if (pathname === "/" || pathname === "/waitlist") {
      return NextResponse.rewrite(new URL("/landing", req.url));
    }
    if (pathname === "/landing") return NextResponse.redirect(`${SITE_ORIGIN}/`, 308);
    if (pathname.startsWith("/api/")) return NextResponse.next();
    return NextResponse.redirect(`${APP_ORIGIN}${pathname}${search}`, 308);
  }

  if (host === APP_HOST && (pathname === "/landing" || pathname === "/waitlist")) {
    return NextResponse.redirect(`${SITE_ORIGIN}/`, 308);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/|icon.svg|opengraph-image|favicon.ico).*)"],
};
