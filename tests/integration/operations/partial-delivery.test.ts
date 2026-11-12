import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNER_ID, SHOP_1, STAFF1_ID, psql, resetLocal, session, sleep, uid } from "./release-helpers";

const MANAGER_ID = "10000000-0000-4000-8000-000000000104";

// Partial delivery, step 1 (20261112090000): record_invoice_delivery races proven with two concurrent database
// sessions. Single-session behaviour (validation, replay, customer rule, void, legacy, closed date, RLS) is in
// supabase/tests/partial_delivery.test.sql. Step 6A (20261112110000): reverse_invoice_delivery races; single-session
// behaviour is in supabase/tests/delivery_reversal.test.sql. Step 6B (20261112120000): correct_invoice_ordered_pieces
// races; single-session behaviour is in supabase/tests/ordered_piece_corrections.test.sql.

const SUITE_TIMEOUT = 210_000;
const RESET_BUDGET = 150_000;

const as = (userId: string) => `set local role authenticated;\nselect set_config('request.jwt.claims', '{"role":"authenticated","sub":"${userId}"}', true) is not null;`;
const deliverSql = (invoiceId: string, key: string, pieces: number) =>
  `select 'del:' || (public.record_invoice_delivery('${JSON.stringify({ shop_id: SHOP_1, invoice_id: invoiceId, pieces, idempotency_key: key })}') ->> 'delivery_id');`;
const voidSql = (invoiceId: string, key: string) =>
  `select 'void:' || (public.void_invoice('${JSON.stringify({ shop_id: SHOP_1, invoice_id: invoiceId, reason: "Customer cancelled the order", idempotency_key: key })}') ->> 'void_id');`;
const reverseSql = (invoiceId: string, deliveryId: string, key: string) =>
  `select 'rev:' || (public.reverse_invoice_delivery('${JSON.stringify({ shop_id: SHOP_1, invoice_id: invoiceId, delivery_id: deliveryId, reason: "Delivered to the wrong customer", idempotency_key: key })}') ->> 'reversal_id');`;
const correctSql = (invoiceId: string, key: string, expected: number, pieces: number) =>
  `select 'fix:' || (public.correct_invoice_ordered_pieces('${JSON.stringify({ shop_id: SHOP_1, invoice_id: invoiceId, expected_ordered_pieces: expected, ordered_pieces: pieces, reason: "Customer changed the order", idempotency_key: key })}') ->> 'correction_id');`;
const ordered = (invoiceId: string) => psql(`select concat_ws('|', ordered_pieces, delivered_pieces, remaining_pieces, delivery_status) from public.invoice_delivery_totals where canonical_invoice_id = '${invoiceId}'`);
const fixes = (invoiceId: string) => psql(`select count(*) from public.invoice_piece_corrections where invoice_id = '${invoiceId}'`);
const reversals = (deliveryId: string) => psql(`select count(*) from public.invoice_deliveries where reverses_delivery_id = '${deliveryId}'`);
/** A committed delivery of `pieces` on the invoice (as the database owner); returns its id. */
async function deliveredEvent(invoiceId: string, pieces: number): Promise<string> {
  const id = crypto.randomUUID();
  await psql(`set timezone = 'Asia/Qatar';
insert into public.invoice_deliveries(id, shop_id, invoice_id, pieces, business_date, created_by, idempotency_key, fingerprint) values ('${id}', '${SHOP_1}', '${invoiceId}', ${pieces}, current_date, '${STAFF1_ID}', 'fix-${uid()}', 'x');`);
  return id;
}
const delivered = (invoiceId: string) => psql(`select concat_ws('|', delivered_pieces, remaining_pieces, delivery_status) from public.invoice_delivery_totals where canonical_invoice_id = '${invoiceId}'`);
const events = (invoiceId: string) => psql(`select count(*) from public.invoice_deliveries where invoice_id = '${invoiceId}'`);

/** A tracked, unpaid 100.00 invoice of 10 pieces dated today, with a customer (so money due never blocks delivery). */
async function tracked(): Promise<string> {
  const invoiceId = crypto.randomUUID(); const customerId = crypto.randomUUID(); const number = `IT-PD-${uid()}`;
  await psql(`set timezone = 'Asia/Qatar';
insert into public.customers(id, shop_id, public_id, name) values ('${customerId}', '${SHOP_1}', 'CUS-${uid()}', 'Delivery race customer');
insert into public.invoices(id, shop_id, customer_id, invoice_id, total_amount_dirham, business_date, ordered_pieces, created_by) values ('${invoiceId}', '${SHOP_1}', '${customerId}', '${number}', 10000, current_date, 10, '${STAFF1_ID}');
insert into public.invoice_number_registry(shop_id, invoice_number, canonical_invoice_id) values ('${SHOP_1}', '${number}', '${invoiceId}');`);
  return invoiceId;
}

/** First session runs `first` inside an open transaction; the second runs `second` and must wait until the first commits. */
async function race(first: string, firstMarker: string, second: string, secondMarker = "del:") {
  const a = session(); const b = session();
  a.send("begin;"); a.send(first); await a.until(firstMarker);
  b.send("begin;"); b.send(second); b.send("commit;");
  await sleep(1_000);
  // psql echoes command tags, so "still waiting" means: no result and no error from the second call yet.
  const waited = !b.output().includes(secondMarker) && b.errors() === "";
  a.send("commit;");
  const [codeA, codeB] = [await a.end(), await b.end()];
  return { waited, codeA, codeB, a, b };
}

describe("partial delivery: concurrent sessions", () => {
  beforeAll(async () => { await resetLocal([], { timeoutMs: RESET_BUDGET }); }, SUITE_TIMEOUT);
  afterAll(async () => { await resetLocal([], { timeoutMs: RESET_BUDGET }); }, SUITE_TIMEOUT);

  it("two deliveries that together exceed the order: the second waits, then gets OVER_DELIVERY", async () => {
    const invoiceId = await tracked();
    const r = await race(`${as(STAFF1_ID)}\n${deliverSql(invoiceId, `a-${uid()}`, 6)}`, "del:", `${as(MANAGER_ID)}\n${deliverSql(invoiceId, `b-${uid()}`, 6)}`);
    expect(r.waited).toBe(true);
    expect(r.codeA, r.a.errors()).toBe(0);
    expect(r.codeB).not.toBe(0);
    expect(r.b.errors()).toContain("OVER_DELIVERY");
    expect(await delivered(invoiceId)).toBe("6|4|partial");
  });

  it("two deliveries that fit: the second waits, then both are recorded", async () => {
    const invoiceId = await tracked();
    const r = await race(`${as(STAFF1_ID)}\n${deliverSql(invoiceId, `a-${uid()}`, 4)}`, "del:", `${as(OWNER_ID)}\n${deliverSql(invoiceId, `b-${uid()}`, 6)}`);
    expect(r.waited).toBe(true);
    expect([r.codeA, r.codeB]).toEqual([0, 0]);
    expect(await delivered(invoiceId)).toBe("10|0|full");
    expect(await events(invoiceId)).toBe("2");
  });

  it("a retried request with the same key: the second waits, then replays the first delivery", async () => {
    const invoiceId = await tracked(); const key = `same-${uid()}`;
    const r = await race(`${as(STAFF1_ID)}\n${deliverSql(invoiceId, key, 3)}`, "del:", `${as(STAFF1_ID)}\n${deliverSql(invoiceId, key, 3)}`);
    expect(r.waited).toBe(true);
    expect([r.codeA, r.codeB]).toEqual([0, 0]);
    expect(/del:(\S+)/.exec(r.b.output())![1]).toBe(/del:(\S+)/.exec(r.a.output())![1]);
    expect(await events(invoiceId)).toBe("1");
    expect(await delivered(invoiceId)).toBe("3|7|partial");
  });

  it("a void in flight: the delivery waits, then is refused with INVOICE_VOID", async () => {
    const invoiceId = await tracked();
    const r = await race(`${as(MANAGER_ID)}\n${voidSql(invoiceId, `v-${uid()}`)}`, "void:", `${as(STAFF1_ID)}\n${deliverSql(invoiceId, `d-${uid()}`, 1)}`);
    expect(r.waited).toBe(true);
    expect(r.codeA, r.a.errors()).toBe(0);
    expect(r.codeB).not.toBe(0);
    expect(r.b.errors()).toContain("INVOICE_VOID");
    expect(await events(invoiceId)).toBe("0");
  });

  it("two reversals of one delivery: the second waits, then gets ALREADY_REVERSED", async () => {
    const invoiceId = await tracked(); const deliveryId = await deliveredEvent(invoiceId, 6);
    const r = await race(`${as(MANAGER_ID)}\n${reverseSql(invoiceId, deliveryId, `a-${uid()}`)}`, "rev:", `${as(OWNER_ID)}\n${reverseSql(invoiceId, deliveryId, `b-${uid()}`)}`, "rev:");
    expect(r.waited).toBe(true);
    expect(r.codeA, r.a.errors()).toBe(0);
    expect(r.codeB).not.toBe(0);
    expect(r.b.errors()).toContain("ALREADY_REVERSED");
    expect(await reversals(deliveryId)).toBe("1");
    expect(await delivered(invoiceId)).toBe("0|10|none");
  });

  it("a retried reversal with the same key: the second waits, then replays the first reversal", async () => {
    const invoiceId = await tracked(); const deliveryId = await deliveredEvent(invoiceId, 6); const key = `same-${uid()}`;
    const r = await race(`${as(MANAGER_ID)}\n${reverseSql(invoiceId, deliveryId, key)}`, "rev:", `${as(MANAGER_ID)}\n${reverseSql(invoiceId, deliveryId, key)}`, "rev:");
    expect(r.waited).toBe(true);
    expect([r.codeA, r.codeB]).toEqual([0, 0]);
    expect(/rev:(\S+)/.exec(r.b.output())![1]).toBe(/rev:(\S+)/.exec(r.a.output())![1]);
    expect(await reversals(deliveryId)).toBe("1");
  });

  it("a reversal in flight: a delivery that only fits after it waits, then is recorded", async () => {
    const invoiceId = await tracked(); const deliveryId = await deliveredEvent(invoiceId, 6); await deliveredEvent(invoiceId, 4);
    const r = await race(`${as(MANAGER_ID)}\n${reverseSql(invoiceId, deliveryId, `a-${uid()}`)}`, "rev:", `${as(STAFF1_ID)}\n${deliverSql(invoiceId, `b-${uid()}`, 6)}`);
    expect(r.waited).toBe(true);
    expect([r.codeA, r.codeB]).toEqual([0, 0]);
    expect(await delivered(invoiceId)).toBe("10|0|full");
  });

  it("a void in flight: the reversal waits, then is refused with INVOICE_VOID", async () => {
    const invoiceId = await tracked(); const deliveryId = await deliveredEvent(invoiceId, 6);
    const r = await race(`${as(MANAGER_ID)}\n${voidSql(invoiceId, `v-${uid()}`)}`, "void:", `${as(OWNER_ID)}\n${reverseSql(invoiceId, deliveryId, `r-${uid()}`)}`, "rev:");
    expect(r.waited).toBe(true);
    expect(r.codeA, r.a.errors()).toBe(0);
    expect(r.codeB).not.toBe(0);
    expect(r.b.errors()).toContain("INVOICE_VOID");
    expect(await reversals(deliveryId)).toBe("0");
  });

  it("two corrections from the same quantity: the second waits, then gets STALE_ORDERED_PIECES", async () => {
    const invoiceId = await tracked();
    const r = await race(`${as(MANAGER_ID)}\n${correctSql(invoiceId, `a-${uid()}`, 10, 12)}`, "fix:", `${as(OWNER_ID)}\n${correctSql(invoiceId, `b-${uid()}`, 10, 8)}`, "fix:");
    expect(r.waited).toBe(true);
    expect(r.codeA, r.a.errors()).toBe(0);
    expect(r.codeB).not.toBe(0);
    expect(r.b.errors()).toContain("STALE_ORDERED_PIECES");
    expect(await ordered(invoiceId)).toBe("12|0|12|none");
    expect(await fixes(invoiceId)).toBe("1");
  });

  it("a retried correction with the same key: the second waits, then replays the first", async () => {
    const invoiceId = await tracked(); const key = `same-${uid()}`;
    const r = await race(`${as(MANAGER_ID)}\n${correctSql(invoiceId, key, 10, 12)}`, "fix:", `${as(MANAGER_ID)}\n${correctSql(invoiceId, key, 10, 12)}`, "fix:");
    expect(r.waited).toBe(true);
    expect([r.codeA, r.codeB]).toEqual([0, 0]);
    expect(await fixes(invoiceId)).toBe("1");
    expect(await ordered(invoiceId)).toBe("12|0|12|none");
  });

  it("a decrease in flight: a delivery that only fit before it waits, then gets OVER_DELIVERY", async () => {
    const invoiceId = await tracked();
    const r = await race(`${as(MANAGER_ID)}\n${correctSql(invoiceId, `a-${uid()}`, 10, 4)}`, "fix:", `${as(STAFF1_ID)}\n${deliverSql(invoiceId, `b-${uid()}`, 6)}`);
    expect(r.waited).toBe(true);
    expect(r.codeA, r.a.errors()).toBe(0);
    expect(r.codeB).not.toBe(0);
    expect(r.b.errors()).toContain("OVER_DELIVERY");
    expect(await ordered(invoiceId)).toBe("4|0|4|none");
  });

  it("a delivery in flight: a decrease below the new delivered count waits, then gets BELOW_DELIVERED", async () => {
    const invoiceId = await tracked();
    const r = await race(`${as(STAFF1_ID)}\n${deliverSql(invoiceId, `a-${uid()}`, 6)}`, "del:", `${as(MANAGER_ID)}\n${correctSql(invoiceId, `b-${uid()}`, 10, 5)}`, "fix:");
    expect(r.waited).toBe(true);
    expect(r.codeA, r.a.errors()).toBe(0);
    expect(r.codeB).not.toBe(0);
    expect(r.b.errors()).toContain("BELOW_DELIVERED");
    expect(await ordered(invoiceId)).toBe("10|6|4|partial");
    expect(await fixes(invoiceId)).toBe("0");
  });
});
