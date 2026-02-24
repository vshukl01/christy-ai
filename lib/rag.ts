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

// Embedding model used at runtime (should match KB build)
const EMBEDDING_MODEL =
  (process.env.EMBEDDING_MODEL || process.env.GEMINI_EMBED_MODEL || "").trim() ||
  "models/gemini-embedding-001";

// Small in-memory query embedding cache (per serverless instance)
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryDelaySeconds(err: any): number | null {
  const details = err?.errorDetails;
  if (!Array.isArray(details)) return null;

  for (const d of details) {
    if (d?.["@type"]?.includes("RetryInfo") && typeof d.retryDelay === "string") {
      const m = d.retryDelay.match(/^(\d+)\s*s$/i);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 6): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt += 1;

      if (err?.status !== 429 || attempt > maxRetries) {
        throw err;
      }

      const retrySec = parseRetryDelaySeconds(err);
      const waitMs =
        retrySec != null ? (retrySec + 1) * 1000 : Math.min(60000, 1000 * 2 ** attempt);

      console.warn(
        `⚠️ [RAG] 429 on ${label}. Retry ${attempt}/${maxRetries} in ${Math.round(waitMs / 1000)}s`
      );
      await sleep(waitMs);
    }
  }
}

async function embedQuery(text: string): Promise<number[]> {
  const q = (text || "").trim();
  if (!q) return [];

  const cached = QUERY_EMBED_CACHE.get(q);
  if (cached) return cached;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const ai = new GoogleGenerativeAI(apiKey);
  const model = ai.getGenerativeModel({ model: EMBEDDING_MODEL });

  const result = await withRetry(() => model.embedContent(q), "embedContent(query)", 8);
  const emb = result?.embedding?.values || [];

  // keep cache bounded
  QUERY_EMBED_CACHE.set(q, emb);
  if (QUERY_EMBED_CACHE.size > QUERY_EMBED_CACHE_MAX) {
    const firstKey = QUERY_EMBED_CACHE.keys().next().value as string | undefined;
    if (firstKey) QUERY_EMBED_CACHE.delete(firstKey);
  }

  return emb;
}

export async function retrieveRelevantContext(query: string, topK = 8): Promise<KBEntry[]> {
  const kb = loadKB();
  if (!kb.length) return [];

  const queryEmbedding = await embedQuery(query);
  if (!queryEmbedding.length) return [];

  const qLower = query.toLowerCase();

  const scored = kb.map((entry) => {
    let score = cosineSim(queryEmbedding, entry.embedding || []);
    const meta = entry.metadata || {};

    // Safe tiny boosts (optional)
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
}