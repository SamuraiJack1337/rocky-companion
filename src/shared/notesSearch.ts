// Pure note-retrieval scoring, dependency-free so both the main process and
// tests can use it. Retrieval is hybrid:
//   - when embeddings are available (query + note), cosine similarity ranks;
//   - otherwise a keyword overlap score keeps retrieval useful with no model.
// At personal-notebook scale (hundreds to a few thousand notes) brute-force
// scoring in memory is plenty — no vector database is needed.

/** The minimal note shape retrieval needs; main's stored notes satisfy it. */
export interface SearchableNote {
  id: string;
  text: string;
  createdAt: string;
  embedding?: number[];
}

export interface RankedNote {
  id: string;
  score: number;
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'so', 'of', 'to', 'in',
  'on', 'at', 'for', 'with', 'about', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'do', 'does', 'did', 'have', 'has', 'had', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'it', 'its', 'this', 'that', 'these', 'those', 'what',
  'which', 'who', 'when', 'where', 'how', 'not', 'no', 'yes', 'can', 'could',
  'would', 'should', 'will', 'just', 'rocky',
]);

/** Lowercased word tokens with stop-words removed. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(
    (t) => t.length > 1 && !STOP_WORDS.has(t),
  );
}

/**
 * Keyword overlap score in [0, 1]: the fraction of distinct query tokens that
 * appear in the note (prefix matches count half, so "deploy" finds
 * "deployment"). 0 when the query has no usable tokens.
 */
export function keywordScore(query: string, noteText: string): number {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) return 0;
  const noteTokens = new Set(tokenize(noteText));
  if (noteTokens.size === 0) return 0;
  let hit = 0;
  for (const q of queryTokens) {
    if (noteTokens.has(q)) {
      hit += 1;
      continue;
    }
    for (const n of noteTokens) {
      if (n.startsWith(q) || q.startsWith(n)) {
        hit += 0.5;
        break;
      }
    }
  }
  return hit / queryTokens.length;
}

/** Cosine similarity of two vectors; 0 for mismatched/degenerate inputs. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Notes scoring below this are never "relevant", they are just noise. */
const MIN_SCORE = 0.12;

/**
 * Rank notes against a query, best first. Uses cosine similarity when both the
 * query embedding and a note embedding exist; keyword overlap otherwise (the
 * two scales are close enough for a personal notebook, and a note is scored by
 * whichever signal is available for it). Notes below a small floor are dropped.
 */
export function rankNotes(
  query: string,
  notes: readonly SearchableNote[],
  queryEmbedding: readonly number[] | null,
  topK: number,
): RankedNote[] {
  const scored: RankedNote[] = [];
  for (const note of notes) {
    const score =
      queryEmbedding && note.embedding && note.embedding.length > 0
        ? cosineSimilarity(queryEmbedding, note.embedding)
        : keywordScore(query, note.text);
    if (score >= MIN_SCORE) scored.push({ id: note.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, topK));
}
