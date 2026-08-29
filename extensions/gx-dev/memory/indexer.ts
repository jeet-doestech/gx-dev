/**
 * Disposable full-text search index over the memory wiki (PLAN §10.2, §10.5:
 * derived indexes are disposable and rebuildable from Markdown). The index is
 * never authoritative — it is always derived from page raw text.
 */

import { parsePage } from "./wiki.ts";

/** One index entry per page: term -> frequency in the page body. */
export interface IndexEntry {
  name: string;
  termFreq: Record<string, number>;
}

/** A single search hit. */
export interface SearchHit {
  name: string;
  score: number;
}

/** ~30 common English stopwords excluded from the index. */
export const STOPWORDS: readonly string[] = [
  "a", "an", "the", "and", "or", "but", "if", "then", "of", "to",
  "in", "on", "for", "with", "as", "by", "at", "from", "is", "are",
  "was", "were", "be", "been", "it", "its", "this", "that", "we",
  "you", "they", "not", "no", "do", "does", "did", "have", "has", "will",
];

const STOPWORD_SET = new Set(STOPWORDS);

/** Lowercased alphanumeric tokens, stopwords and bare numbers removed. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORD_SET.has(t) && !/^\d+$/.test(t));
}

/** Strips markdown syntax, keeping readable body words. */
export function bodyText(raw: string): string {
  const { body } = parsePage(raw);
  return body
    .replace(/^[ \t]*```[^\n]*$/gm, " ") // fence lines (keep inner text)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, a: string, b: string | undefined) => `${a} ${b ?? ""}`)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](url) -> label
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/[*_>`|#]+/g, " ") // emphasis/quote/table punctuation
    .replace(/^\s*[-+]\s+/gm, " "); // list markers
}

/** Builds a JSON-serializable index from page raw texts. Deterministic. */
export function buildIndex(pages: { name: string; raw: string }[]): IndexEntry[] {
  return pages.map((page) => {
    const termFreq: Record<string, number> = {};
    for (const term of tokenize(bodyText(page.raw))) {
      termFreq[term] = (termFreq[term] ?? 0) + 1;
    }
    return { name: page.name, termFreq };
  });
}

/**
 * Scores pages by summed term frequency over the query terms. Pages whose
 * name appears in `indexNames` (i.e. linked from index.md) are boosted ×2.
 * Results: score descending, then name ascending for determinism.
 */
export function searchIndex(
  index: IndexEntry[],
  query: string,
  limit = 10,
  indexNames: string[] = [],
): SearchHit[] {
  const boosted = new Set(indexNames);
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of index) {
    let score = 0;
    for (const term of queryTerms) score += entry.termFreq[term] ?? 0;
    if (score === 0) continue;
    if (boosted.has(entry.name)) score *= 2;
    hits.push({ name: entry.name, score });
  }
  return hits
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, Math.max(0, limit));
}
