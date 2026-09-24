# Phase 3 operational UI slice status

The current invoice-entry slice serves the seeded Shop 1 staff workflow. It selects the first shop visible to the signed-in actor and does not expose a shop picker.

**Deferred:** owner and other multi-shop users need an explicit authorized shop switcher before the broader Phase 3 operational workspace is complete. The server action and `submit_batch` still enforce shop authorization for every submitted command.

**Deferred:** the owner business-date selector and backdated-reason entry are not in this slice. The RPC continues to enforce owner-only backdated submissions and closed-day rules.

**Deferred:** searchable customer selection beyond the first 200 names is not in this slice. The RPC continues to require a customer for a delivered invoice with due and validates that existing customers belong to the submitted shop.
