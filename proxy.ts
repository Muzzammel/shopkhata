import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { safeReturnPath } from "@/lib/auth/return-path";
import type { Database } from "@/lib/supabase/database.types";

type CookieToSet = {
  name: string;
  value: string;
  options: CookieOptions;
};

function publicSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  return url && key ? { url, key } : null;
}

function requestReturnPath(request: NextRequest): string {
  return safeReturnPath(`${request.nextUrl.pathname}${request.nextUrl.search}`, request.nextUrl.origin);
}

function copyAuthState(
  response: NextResponse,
  cookiesToSet: readonly CookieToSet[],
  headers: Readonly<Record<string, string>>,
): void {
  for (const { name, value, options } of cookiesToSet) {
    response.cookies.set(name, value, options);
  }

  for (const [name, value] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  // The health response contains no business data and is intentionally public
  // so a host monitor can check readiness without holding an account session.
  if (request.nextUrl.pathname === "/api/health") return NextResponse.next();

  const config = publicSupabaseConfig();
  const refreshedCookies: CookieToSet[] = [];
  const refreshedHeaders: Record<string, string> = {};
  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  if (!config) {
    if (request.nextUrl.pathname === "/login") {
      return response;
    }

    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", requestReturnPath(request));
    return NextResponse.redirect(loginUrl);
  }

  const supabase = createServerClient<Database>(config.url, config.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const cookie of cookiesToSet) {
          request.cookies.set(cookie.name, cookie.value);
          refreshedCookies.push(cookie);
        }

        Object.assign(refreshedHeaders, headers);
        response = NextResponse.next({
          request: { headers: request.headers },
        });
        copyAuthState(response, refreshedCookies, refreshedHeaders);
      },
    },
  });

  let claims: unknown = null;
  try {
    const { data } = await supabase.auth.getClaims();
    claims = data?.claims ?? null;
  } catch {
    claims = null;
  }
  const isLoginRoute =
    request.nextUrl.pathname === "/login" ||
    request.nextUrl.pathname.startsWith("/login/");

  // The offline page is static and carries no server data; the service worker
  // must be able to fetch it without a session.
  if (isLoginRoute || claims || request.nextUrl.pathname === "/offline") {
    return response;
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("next", requestReturnPath(request));

  const redirectResponse = NextResponse.redirect(loginUrl);
  copyAuthState(redirectResponse, refreshedCookies, refreshedHeaders);
  return redirectResponse;
}

export const config = {
  matcher: [
    "/",
    "/((?!_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)",
  ],
};
