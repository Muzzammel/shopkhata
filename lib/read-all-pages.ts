export async function readAllPages<T>(fetchPage: (offset: number, end: number) => PromiseLike<{ data: T[] | null; error: unknown }>, size = 500): Promise<{ data: T[] | null; error: unknown }> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += size) {
    const page = await fetchPage(offset, offset + size - 1);
    if (page.error || !page.data) return { data: null, error: page.error ?? new Error("READ_UNAVAILABLE") };
    rows.push(...page.data);
    if (page.data.length < size) return { data: rows, error: null };
  }
}
