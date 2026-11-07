// OPS-01B P1C: a bounded LEXER (not a parser) for function bodies (prosrc). It only separates string literals from code
// and comments, so the release tests can prove that no protected body has a literal whose runtime value would change
// with the file's line endings. Recognized: '...' with '' doubling, E'...' with backslash escapes, U&'...', "ident",
// $tag$...$tag$ (not $1 parameters), -- line comments and nested /* */ comments. PostgreSQL's lexer treats both \n
// and \r as newline, so a CR can only reach runtime data from inside a literal.

export type Literal = { kind: "quoted" | "escape" | "dollar"; text: string; at: number };

export function literals(src: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  const n = src.length;
  const identChar = (c: string | undefined) => !!c && /[A-Za-z0-9_$\u0080-￿]/.test(c);
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "-" && next === "-") { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (c === "/" && next === "*") {
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (src[i] === "/" && src[i + 1] === "*") { depth++; i += 2; } else if (src[i] === "*" && src[i + 1] === "/") { depth--; i += 2; } else i++;
      }
      continue;
    }
    if (c === '"') { i++; while (i < n) { if (src[i] === '"') { if (src[i + 1] === '"') { i += 2; continue; } i++; break; } i++; } continue; }
    if (c === "'") {
      const escape = /[eE]/.test(src[i - 1] ?? "") && !identChar(src[i - 2]);
      const start = i; i++;
      while (i < n) {
        if (escape && src[i] === "\\") { i += 2; continue; }
        if (src[i] === "'") { if (src[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      out.push({ kind: escape ? "escape" : "quoted", text: src.slice(start, i), at: start });
      continue;
    }
    if (c === "$" && !identChar(src[i - 1])) {
      const m = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(src.slice(i));
      if (m) {
        const end = src.indexOf(m[0], i + m[0].length);
        const stop = end < 0 ? n : end + m[0].length;
        out.push({ kind: "dollar", text: src.slice(i, stop), at: i });
        i = stop;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** Literals whose runtime value would depend on line endings: a raw CR or LF inside the literal's characters. */
export const lineEndingSensitive = (src: string) => literals(src).filter((l) => /[\r\n]/.test(l.text));
/** Literals that produce a CR at runtime by escape (E'\r', \015, \x0d, \u000d) - not touched by the canonical rule. */
export const escapedCr = (src: string) =>
  literals(src).filter((l) => l.kind === "escape" && /\\(r|0?15|x0?[dD]|u000[dD]|U0000000[dD])/.test(l.text));
