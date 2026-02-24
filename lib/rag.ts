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

// ---- Embedding model candidates (auto-pick first that works) ----
const EMBEDDING_MODEL_OVERRIDE = (process.env.GEMINI_EMBED_MODEL || process.env.EMBEDDING_MODEL || "").trim();

const EMBEDDING_MODEL_CANDIDATES = [
  // ✅ your working one (per your terminal logs)
  "models/gemini-embedding-001",

  // keep older fallbacks (may 404 depending on project)
  "models/embedding-001",
  "models/text-embedding-001",
];

// Cache selected model on cold start
let SELECTED_EMBED_MODEL: string | null = null;

// Lightweight in-memory cache for query embeddings (avoid repeated calls)
const QUERY_EMBED_CACHE = new Map<string, number[]>();
const QUERY_EMBED_CACHE_MAX = 250;

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

      const status = err?.status;
      if (status !== 429 || attempt > maxRetries) {
        throw err;
      }

      const retrySec = parseRetryDelaySeconds(err);
      const backoffMs =
        retrySec != null
          ? (retrySec + 1) * 1000
          : Math.min(60000, 1000 * Math.pow(2, attempt));

      console.warn(`[RAG] Rate-limited on ${label}. Retry ${attempt}/${maxRetries} in ${Math.round(backoffMs / 1000)}s`);
      await sleep(backoffMs);
    }
  }
}

async function tryEmbedPing(ai: GoogleGenerativeAI, modelName: string) {
  const model = ai.getGenerativeModel({ model: modelName });
  // ✅ IMPORTANT: pass string (SDK supports), if your TS complains you can swap to object form below
  // await model.embedContent({ content: { parts: [{ text: "ping" }] } });
  const resp = await model.embedContent("ping");
  const vec = resp?.embedding?.values || [];
  if (!Array.isArray(vec) || vec.length < 10) {
    throw new Error(`Invalid embedding vector from ${modelName}`);
  }
}

async function pickEmbeddingModel(ai: GoogleGenerativeAI): Promise<string> {
  if (SELECTED_EMBED_MODEL) return SELECTED_EMBED_MODEL;

  if (EMBEDDING_MODEL_OVERRIDE) {
    await withRetry(() => tryEmbedPing(ai, EMBEDDING_MODEL_OVERRIDE), `embed ping (${EMBEDDING_MODEL_OVERRIDE})`);
    SELECTED_EMBED_MODEL = EMBEDDING_MODEL_OVERRIDE;
    return SELECTED_EMBED_MODEL;
  }

  for (const m of EMBEDDING_MODEL_CANDIDATES) {
    try {
      await withRetry(() => tryEmbedPing(ai, m), `embed ping (${m})`);
      SELECTED_EMBED_MODEL = m;
      return SELECTED_EMBED_MODEL;
    } catch {
      // try next
    }
  }

  // last resort
  SELECTED_EMBED_MODEL = "models/gemini-embedding-001";
  return SELECTED_EMBED_MODEL;
}

async function embedQuery(text: string): Promise<number[]> {
  // cache
  const cached = QUERY_EMBED_CACHE.get(text);
  if (cached) return cached;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const ai = new GoogleGenerativeAI(apiKey);
  const embedModelName = await pickEmbeddingModel(ai);
  const model = ai.getGenerativeModel({ model: embedModelName });

  // ✅ If the SDK version ever becomes strict, switch to object form:
  // const result = await model.embedContent({ content: { parts: [{ text }] } });

  const result = await withRetry(() => model.embedContent(text), "embedContent");

  const emb = result?.embedding?.values || [];

  // Maintain small cache
  QUERY_EMBED_CACHE.set(text, emb);
  if (QUERY_EMBED_CACHE.size > QUERY_EMBED_CACHE_MAX) {
    // delete oldest safely (fixes TS red underline)
    const first = QUERY_EMBED_CACHE.keys().next();
    if (!first.done && first.value) QUERY_EMBED_CACHE.delete(first.value);
  }

  return emb;
}

export async function retrieveRelevantContext(query: string, topK = 8): Promise<KBEntry[]> {
  const kb = loadKB();
  if (!kb.length) return [];

  const queryEmbedding = await embedQuery(query);
  const qLower = query.toLowerCase();

  const scored = kb.map((entry) => {
    let score = cosineSim(queryEmbedding, entry.embedding || []);
    const meta = entry.metadata || {};

    // tiny boosts
    try {
      if (meta.model_name) {
        const m = String(meta.model_name).toLowerCase();
        if (m && qLower.includes(m)) score += 0.04;
      }
      if (meta.product_id) {
        const id = String(meta.product_id).toLowerCase();
        if (id && qLower.includes(id)) score += 0.02;
      }
    } catch {}

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.entry);
}