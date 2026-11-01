// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { AppShell } from "@/components/shell/app-shell";
import { pickShop } from "@/lib/shop-switching";

const nav = vi.hoisted(() => ({ pathname: "/dashboard", search: "", shown: [] as (string | null)[] }));
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname, useSearchParams: () => new URLSearchParams(nav.search) }));
vi.mock("@/components/shell/top-nav", () => ({ TopNav: ({ shop }: { shop: { id: string } | null }) => { nav.shown.push(shop?.id ?? null); return null; } }));
vi.mock("@/components/shell/quick-action-rail", () => ({ QuickActionRail: () => null }));
vi.mock("@/components/shell/mobile-bottom-nav", () => ({ MobileBottomNav: () => null }));
vi.mock("@/components/shell/global-search", () => ({ GlobalSearch: () => null }));
afterEach(() => { cleanup(); nav.shown = []; });

const user = { id: "owner", name: "Owner", role: "owner" as const };

/** Renders the shell for one owner request and returns the shop its switcher shows. */
function shellPick(rows: { id: string; name: string; is_active: boolean }[], search: string) {
  nav.search = search;
  const shops = rows.map(({ id, name, is_active }) => ({ id, name, isActive: is_active })); // as app/(app)/layout.tsx
  const props = { shops, user, isOwner: true, permissions: {}, children: null };
  render(createElement(AppShell, props));
  return nav.shown.at(-1);
}

describe("AppShell shop pick", () => {
  const mixed = [{ id: "a", name: "A", is_active: false }, { id: "b", name: "B", is_active: true }];
  const allInactive = mixed.map((shop) => ({ ...shop, is_active: false }));

  for (const [label, rows, search] of [
    ["active shop exists, no ?shop=", mixed, ""],
    ["explicit inactive shop", mixed, "shop=a"],
    ["every shop inactive, no ?shop=", allInactive, ""],
    ["every shop inactive, explicit shop", allInactive, "shop=b"],
  ] as const) {
    it(`matches the page's pickShop: ${label}`, () => {
      const page = pickShop(rows, new URLSearchParams(search).get("shop") ?? undefined);
      expect(shellPick([...rows], search)).toBe(page?.id);
      const banner = screen.queryByRole("status");
      if (page?.is_active) expect(banner).toBeNull();
      else expect(banner?.textContent).toContain(`INACTIVE — READ ONLY · ${page?.name} is inactive`);
    });
  }
});
