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

// Prefer a known-good embedding model for v1beta
const EMBED_MODEL_OVERRIDE = (process.env.GEMINI_EMBED_MODEL || "").trim();
const EMBED_MODEL_CANDIDATES = [
  EMBED_MODEL_OVERRIDE,
  "models/gemini-embedding-001",
  "models/embedding-001",
].filter(Boolean);

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

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in server environment.");
  return new GoogleGenerativeAI(apiKey);
}

async function tryEmbed(modelName: string, text: string): Promise<number[]> {
  const ai = getGeminiClient();
  const model = ai.getGenerativeModel({ model: modelName });
  const res = await model.embedContent(text);
  const vec = res?.embedding?.values || [];
  if (!Array.isArray(vec) || vec.length < 10) throw new Error("Bad embedding vector");
  return vec;
}

async function embedQuery(text: string): Promise<number[]> {
  const key = text.trim().slice(0, 5000); // avoid giant cache keys
  const cached = QUERY_EMBED_CACHE.get(key);
  if (cached) return cached;

  let lastErr: any = null;

  for (const modelName of EMBED_MODEL_CANDIDATES) {
    try {
      const vec = await tryEmbed(modelName, key);

      // simple LRU-ish cap
      QUERY_EMBED_CACHE.set(key, vec);
      if (QUERY_EMBED_CACHE.size > QUERY_EMBED_CACHE_MAX) {
        const firstKey = QUERY_EMBED_CACHE.keys().next().value as string | undefined;
        if (firstKey) QUERY_EMBED_CACHE.delete(firstKey);
      }

      return vec;
    } catch (e: any) {
      lastErr = e;
      // try next model
    }
  }

  throw new Error(
    `[RAG] Failed to embed query. Tried: ${EMBED_MODEL_CANDIDATES.join(
      ", "
    )}. Last error: ${lastErr?.message || lastErr}`
  );
}

export async function retrieveRelevantContext(
  query: string,
  topK = 8
): Promise<KBEntry[]> {
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