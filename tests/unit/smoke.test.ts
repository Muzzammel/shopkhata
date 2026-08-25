import { describe, expect, it } from "vitest";

import { APP_NAME } from "@/lib/domain/constants";

describe("ShopKhata foundation", () => {
  it("exposes the approved product name", () => {
    expect(APP_NAME).toBe("ShopKhata");
  });
});
