// Heuristic: does a decoded "dialogue" string look like real English game text, or like
// code/graphics bytes that merely happened to decode through the charmap?
// The pointer scan accepts anything that decodes cleanly, so it also picks up such noise
// (e.g. "Œ ì", "Â Ön+ò"). English Gen 3 text uses ASCII plus é; accented capitals and
// stray symbols are the giveaway. Used as a reversible UI filter, never to drop entries.

const STRIP = /\{[^}]*\}|\\[nlp]|\n/g;

export function looksLikeJunk(text: string): boolean {
  const t = text.replace(STRIP, " ");
  const visible = [...t].filter((c) => !/\s/.test(c));
  if (!visible.length) return true;

  // any letter outside ASCII, other than é/É, never occurs in English text
  for (const c of visible) if (/\p{L}/u.test(c) && !/[A-Za-z]/.test(c) && c !== "é" && c !== "É") return true;

  const letters = visible.filter((c) => /[A-Za-z]/.test(c)).length;
  if (letters < 2) return true;
  // mostly symbols/digits
  if (letters / visible.length < 0.5) return true;

  // words without any vowel ("yj", "l", "Vn") dominate
  // apostrophes belong to the word ("I’m"); a lone I or A is a word too
  // (clitics such as the "’s" after a {PLAYER} tag are not words on their own)
  const words = (t.match(/[A-Za-z’']+/g) ?? []).filter((w) => !/^[’']/.test(w));
  const vowelly = words.filter((w) => /[aeiou]/i.test(w) || (/y/i.test(w) && w.length >= 2)).length;
  if (words.length >= 2 && vowelly / words.length < 0.4) return true;
  return false;
}
