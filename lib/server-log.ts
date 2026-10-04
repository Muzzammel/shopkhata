/**
 * One JSON line on the server log per failed operation, so a failure seen by a
 * user can be found afterwards. A database error with a code is a rule the
 * database enforced ("warn"); one without a code means the result is unknown
 * ("error"). Only identifiers and error codes are logged — never a payload,
 * a name, an amount, error details (they can quote row values) or a token.
 */
export function logFailure(
  operation: string,
  error: { code?: string | null; message?: string } | null,
  context: { shopId?: string; actorId?: string } = {},
): void {
  const line = { at: new Date().toISOString(), app: "shopkhata", level: error?.code ? "warn" : "error", operation, code: error?.code ?? null, reason: error?.message?.slice(0, 200) ?? "unconfirmed", ...context };
  (line.level === "error" ? console.error : console.warn)(JSON.stringify(line));
}
