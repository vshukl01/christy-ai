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

// Optional override via env
const EMBEDDING_MODEL_OVERRIDE = (process.env.EMBEDDING_MODEL || "").trim();

// Keep same candidates as the KB script
const EMBEDDING_MODEL_CANDIDATES = [
  "models/text-embedding-004",
  "models/gemini-embedding-001",
  "models/text-embedding-001",
  "models/embedding-001",
];

let SELECTED_EMBED_MODEL: string | null = null;

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

function getClient(): GoogleGenerativeAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY in server environment.");
  return new GoogleGenerativeAI(apiKey);
}

async function tryEmbedOnce(ai: GoogleGenerativeAI, modelName: string) {
  const model = ai.getGenerativeModel({ model: modelName });
  const resp = await model.embedContent("ping");
  const vec = (resp as any)?.embedding?.values || [];
  if (!Array.isArray(vec) || vec.length < 10) {
    throw new Error(`Embedding vector invalid for model ${modelName}`);
  }
}

async function pickEmbeddingModel(ai: GoogleGenerativeAI): Promise<string> {
  if (SELECTED_EMBED_MODEL) return SELECTED_EMBED_MODEL;

  if (EMBEDDING_MODEL_OVERRIDE) {
    await tryEmbedOnce(ai, EMBEDDING_MODEL_OVERRIDE);
    SELECTED_EMBED_MODEL = EMBEDDING_MODEL_OVERRIDE;
    return SELECTED_EMBED_MODEL;
  }

  for (const m of EMBEDDING_MODEL_CANDIDATES) {
    try {
      await tryEmbedOnce(ai, m);
      SELECTED_EMBED_MODEL = m;
      return SELECTED_EMBED_MODEL;
    } catch {
      // try next
    }
  }

  throw new Error(
    `No embedding model worked. Tried: ${EMBEDDING_MODEL_CANDIDATES.join(", ")}`
  );
}

async function embedQuery(text: string): Promise<number[]> {
  const ai = getClient();
  const modelName = await pickEmbeddingModel(ai);
  const model = ai.getGenerativeModel({ model: modelName });

  const result = await model.embedContent(text);
  return (result as any)?.embedding?.values || [];
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
      if (meta.category) {
        const c = String(meta.category).toLowerCase();
        if (c && qLower.includes(c)) score += 0.01;
      }
    } catch {}

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => s.entry);
}