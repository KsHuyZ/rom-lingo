// Control-token helpers shared by the browser and the server.
// The server cannot fully encode text (the user's .tbl lives in the browser),
// so it validates structure: same control tokens, and size for fixed slots.

const TOKEN_RE = /\\[nlp]|\{[^}]*\}/g;

/** Control tokens in order, e.g. ["{PLAYER}", "\\p", "{FC:01 02}"]. */
export function controlTokens(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

const PH_RE = /⟦\s*(\d+)\s*⟧/g;

/**
 * Swap each control token for a numbered placeholder (⟦1⟧, ⟦2⟧ …) so the model sees
 * opaque markers instead of "\\p" / "{PLAYER}" it might rewrite. Returns the masked
 * text and the token list to restore with {@link unmaskTokens}.
 */
export function maskTokens(text: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  const masked = text.replace(TOKEN_RE, (t) => {
    tokens.push(t);
    return `⟦${tokens.length}⟧`;
  });
  return { masked, tokens };
}

/** Put the original tokens back. Unknown placeholders are left as-is so validation flags them. */
export function unmaskTokens(text: string, tokens: string[]): string {
  return text.replace(PH_RE, (m, n) => tokens[Number(n) - 1] ?? m);
}

/** True when a placeholder survived unmasking (model invented or mangled one). */
export function hasPlaceholder(text: string): boolean {
  return /[⟦⟧]/.test(text);
}

/** True when both strings contain the same control tokens (order-insensitive). */
export function sameTokens(a: string, b: string): boolean {
  const x = controlTokens(a).sort();
  const y = controlTokens(b).sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/**
 * Encoded size in bytes incl. the 0xFF terminator, assuming every plain
 * character maps to one byte (true for Gen 3 tables, incl. custom .tbl).
 */
export function approxBytes(text: string): number {
  let n = 1;
  for (const part of text.split(TOKEN_RE)) n += [...part].length;
  for (const t of controlTokens(text)) {
    if (t.startsWith("\\")) n += 1;
    else if (/^\{FC:/.test(t)) n += 1 + t.slice(4, -1).trim().split(/\s+/).length;
    else if (/^\{(F[789]|FD):/.test(t) || /^\{(PLAYER|RIVAL|STR_VAR_\d)\}$/.test(t)) n += 2;
    else n += 1; // {PK}, {LV}, raw {XX}
  }
  return n;
}

/** Plain characters a translator sees — the unit credits are billed on. */
export function billableChars(text: string): number {
  return [...text.replace(TOKEN_RE, "")].length;
}

export function chunkCost(chars: number, creditsPer1k: number): number {
  return Math.max(1, Math.ceil((chars * creditsPer1k) / 1000));
}
