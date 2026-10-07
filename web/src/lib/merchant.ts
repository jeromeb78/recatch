// Letter monograms for stores (no third-party logos).
const PALETTE = [
  { bg: "var(--mono-blue-bg)", fg: "var(--mono-blue-fg)" },
  { bg: "var(--mono-red-bg)", fg: "var(--mono-red-fg)" },
  { bg: "var(--mono-amber-bg)", fg: "var(--mono-amber-fg)" },
  { bg: "var(--mono-green-bg)", fg: "var(--mono-green-fg)" },
  { bg: "var(--mono-violet-bg)", fg: "var(--mono-violet-fg)" },
];

export function monogram(merchant: string | null) {
  const name = (merchant ?? "?").trim() || "?";
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { letter: name[0].toUpperCase(), ...PALETTE[h % PALETTE.length] };
}

export const SOURCE_LABEL: Record<string, string> = { gmail: "Gmail", forward: "Forwarded", upload: "Photo" };
