// lib/rag.ts
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

export type KBEntry = {
  id: string;
  text: string;
  source: string;
  metadata: Record<string, any>;
  embedding: number[];
};

let KB_CACHE: KBEntry[] | null = null;

// ✅ Use the env var you actually have on Vercel
// (fallbacks included so local doesn't break)
const EMBED_MODEL =
  (process.env.GEMINI_EMBED_MODEL || process.env.EMBEDDING_MODEL || "").trim() ||
  "models/text-embedding-001";

// Small in-memory cache for query embeddings (avoid re-embedding same query)
const QUERY_EMBED_CACHE_MAX = 200;
const QUERY_EMBED_CACHE = new Map<string, number[]>();

function loadKB(): KBEntry[] {
  if (KB_CACHE) return KB_CACHE;

  const kbPath = path.join(process.cwd(), "data", "rag", "knowledge_base.json");

  if (!fs.existsSync(kbPath)) {
    console.warn("[RAG] knowledge_base.json not found → returning empty context.");
    KB_CACHE = [];
    return KB_CACHE;
  }

  const raw = fs.readFileSync(kbPath, "utf8");
  KB_CACHE = JSON.parse(raw) as KBEntry[];
  return KB_CACHE;
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;

  const len = Math.min(a.length, b.length);

  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB) || 1;
  return dot / denom;
}

function safeGetGeminiClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");
  return new GoogleGenerativeAI(apiKey);
}

async function embedQuery(text: string): Promise<number[]> {
  const key = text.trim().slice(0, 5000); // keep cache key bounded

  const cached = QUERY_EMBED_CACHE.get(key);
  if (cached) return cached;

  const ai = safeGetGeminiClient();
  const model = ai.getGenerativeModel({ model: EMBED_MODEL });

  // ✅ Correct SDK usage for @google/generative-ai ^0.24.x
  const result = await model.embedContent(text);
  const emb = result?.embedding?.values || [];

  if (!Array.isArray(emb) || emb.length === 0) {
    throw new Error(`Embedding returned empty vector (model=${EMBED_MODEL})`);
  }

  // maintain cache size
  QUERY_EMBED_CACHE.set(key, emb);
  if (QUERY_EMBED_CACHE.size > QUERY_EMBED_CACHE_MAX) {
    const firstKey = QUERY_EMBED_CACHE.keys().next().value as string | undefined;
    if (firstKey !== undefined) {
      QUERY_EMBED_CACHE.delete(firstKey);
    }
  }

  return emb;
}

/**
 * Fallback retrieval when embeddings fail:
 * Simple lexical scoring = count of query terms present in entry text/source/metadata
 */
function lexicalRetrieve(kb: KBEntry[], query: string, topK: number): KBEntry[] {
  const q = query.toLowerCase();
  const terms = q.split(/[^a-z0-9]+/g).filter(Boolean);

  const scored = kb.map((entry) => {
    const hay =
      `${entry.source}\n${entry.text}\n${JSON.stringify(entry.metadata || {})}`.toLowerCase();

    let score = 0;
    for (const t of terms) {
      if (t.length < 2) continue;
      if (hay.includes(t)) score += 1;
    }
    // small preference for price sheet if query seems like pricing/stock
    if (
      entry.source === "price_sheet" &&
      /(price|cost|\$|stock|available|inventory|doa|warranty)/i.test(query)
    ) {
      score += 1.5;
    }

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.entry);
}

export async function retrieveRelevantContext(
  query: string,
  topK = 8
): Promise<KBEntry[]> {
  const kb = loadKB();
  if (!kb.length) return [];

  // If no embeddings exist in KB (shouldn't happen if build worked), fallback lexical
  const kbHasEmbeddings = kb.some((e) => Array.isArray(e.embedding) && e.embedding.length > 0);
  if (!kbHasEmbeddings) {
    return lexicalRetrieve(kb, query, topK);
  }

  try {
    const queryEmbedding = await embedQuery(query);
    const qLower = query.toLowerCase();

    const scored = kb.map((entry) => {
      let score = cosineSim(queryEmbedding, entry.embedding || []);
      const meta = entry.metadata || {};

      // Small bonuses based on metadata matches (safe)
      try {
        if (meta.model_name) {
          const m = String(meta.model_name).toLowerCase();
          if (m && qLower.includes(m)) score += 0.04;
        }
        if (meta.product_id) {
          const id = String(meta.product_id).toLowerCase();
          if (id && qLower.includes(id)) score += 0.02;
        }
      } catch {
        // ignore
      }

      return { entry, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.entry);
  } catch (e) {
    // ✅ If embedding fails in production due to quota / model changes, don't break the app
    console.warn("[RAG] embedQuery failed, using lexical fallback:", (e as any)?.message || e);
    return lexicalRetrieve(kb, query, topK);
  }
}