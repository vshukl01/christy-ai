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

// ✅ Match Vercel env var naming
const EMBED_MODEL =
  (process.env.GEMINI_EMBED_MODEL || "").trim() || "models/gemini-embedding-001";

const KB_PATH = path.join(process.cwd(), "data", "rag", "knowledge_base.json");

// Small in-memory cache to reduce embed calls on repeat queries
const QUERY_EMBED_CACHE = new Map<string, number[]>();
const QUERY_EMBED_CACHE_MAX = 200;

function loadKB(): KBEntry[] {
  if (KB_CACHE) return KB_CACHE;

  if (!fs.existsSync(KB_PATH)) {
    console.warn("[RAG] knowledge_base.json not found → empty context.");
    KB_CACHE = [];
    return KB_CACHE;
  }

  const raw = fs.readFileSync(KB_PATH, "utf8");
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

function normalizeModelName(name: string) {
  // Accept both "models/xxx" and "xxx"
  return name.startsWith("models/") ? name : `models/${name}`;
}

async function embedWithRetry(text: string, maxRetries = 6): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY (server env).");

  const normalizedEmbedModel = normalizeModelName(EMBED_MODEL);

  const ai = new GoogleGenerativeAI(apiKey);
  const model = ai.getGenerativeModel({ model: normalizedEmbedModel });

  let attempt = 0;
  while (true) {
    try {
      const result = await model.embedContent(text);
      return result.embedding.values || [];
    } catch (err: any) {
      const msg = String(err?.message || "");
      const is429 = msg.includes("429") || msg.toLowerCase().includes("too many requests");

      attempt++;
      if (!is429 || attempt > maxRetries) {
        throw new Error(
          `[RAG] embed failed (model=${normalizedEmbedModel}) attempt=${attempt}: ${msg}`
        );
      }

      // exponential backoff with cap
      const waitMs = Math.min(30000, 1000 * Math.pow(2, attempt));
      await sleep(waitMs);
    }
  }
}

async function embedQuery(query: string): Promise<number[]> {
  const key = query.trim().toLowerCase();
  if (!key) return [];

  const cached = QUERY_EMBED_CACHE.get(key);
  if (cached) return cached;

  const emb = await embedWithRetry(query);

  QUERY_EMBED_CACHE.set(key, emb);
  if (QUERY_EMBED_CACHE.size > QUERY_EMBED_CACHE_MAX) {
  // delete oldest (Map preserves insertion order)
  const first = QUERY_EMBED_CACHE.keys().next();
  if (!first.done) {
    QUERY_EMBED_CACHE.delete(first.value);
  }
}

  return emb;
}

export async function retrieveRelevantContext(
  query: string,
  topK = 8
): Promise<KBEntry[]> {
  const kb = loadKB();
  if (!kb.length) return [];

  const queryEmbedding = await embedQuery(query);
  if (!queryEmbedding.length) return [];

  const qLower = query.toLowerCase();

  const scored = kb.map((entry) => {
    let score = cosineSim(queryEmbedding, entry.embedding || []);
    const meta = entry.metadata || {};

    // small metadata boosts
    try {
      if (meta.model_name) {
        const m = String(meta.model_name).toLowerCase();
        if (m && qLower.includes(m)) score += 0.04;
      }
      if (meta.product_id) {
        const id = String(meta.product_id).toLowerCase();
        if (id && qLower.includes(id)) score += 0.02;
      }
      if (meta.category) {
        const c = String(meta.category).toLowerCase();
        if (c && qLower.includes(c)) score += 0.01;
      }
    } catch {
      // ignore
    }

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.entry);
}