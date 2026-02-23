// lib/rag.ts
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Embedding model
const EMBEDDING_MODEL = "models/text-embedding-004";

export type KBEntry = {
  id: string;
  text: string;
  source: string;
  metadata: Record<string, any>;
  embedding: number[];
};

let KB_CACHE: KBEntry[] | null = null;

/* =======================
   Gemini Client (Safe)
======================= */

function getGeminiClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "Missing GEMINI_API_KEY in server environment. Add it to Vercel Env Vars and .env.local."
    );
  }
  return new GoogleGenerativeAI(key);
}

/* =======================
     Load Knowledge Base
======================= */

function loadKB(): KBEntry[] {
  if (KB_CACHE) return KB_CACHE;

  // ✅ Your actual structure is data/rag/knowledge_base.json
  const kbPath = path.join(process.cwd(), "data", "rag", "knowledge_base.json");

  if (!fs.existsSync(kbPath)) {
    console.warn(
      `[RAG] knowledge_base.json not found at ${kbPath} → returning empty context.`
    );
    KB_CACHE = [];
    return KB_CACHE;
  }

  const raw = fs.readFileSync(kbPath, "utf8");
  KB_CACHE = JSON.parse(raw) as KBEntry[];
  return KB_CACHE;
}

/* =======================
       Cosine Similarity
======================= */

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

/* =======================
    Embed User Question
======================= */

async function embedQuery(text: string): Promise<number[]> {
  const ai = getGeminiClient();
  const model = ai.getGenerativeModel({
    model: EMBEDDING_MODEL,
  });

  const result = await model.embedContent(text);
  const vec = result?.embedding?.values;

  if (!Array.isArray(vec) || vec.length === 0) {
    throw new Error("Failed to create query embedding (empty embedding vector).");
  }

  return vec;
}

/* =======================
   Retrieve Matching Context
======================= */

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
    const category = (meta.category || "").toString().toLowerCase();

    // Small bonuses based on metadata matches
    try {
      if (meta.model_name) {
        const m = String(meta.model_name).toLowerCase();
        if (m && qLower.includes(m)) score += 0.06;
      }
      if (meta.product_id) {
        const id = String(meta.product_id).toLowerCase();
        if (id && qLower.includes(id)) score += 0.03;
      }

      if (entry.source === "price_sheet") {
        // Miner-related queries
        if (
          /s19|s21|m50|m60|whatsminer|mining|asic|hashrate|th\/s/i.test(query) &&
          category === "miner"
        ) {
          score += 0.05;
        }

        // Transformer-related queries
        if (
          /transformer|kva|mva|padmount|wye|delta|tap/i.test(query) &&
          category === "transformer"
        ) {
          score += 0.06;
        }

        // Hosting-related queries
        if (
          /hosting|colocation|colo|facility/i.test(query) &&
          category === "hosting"
        ) {
          score += 0.04;
        }
      }
    } catch {
      // ignore metadata problems
    }

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Return top-K entries
  return scored.slice(0, topK).map((s) => s.entry);
}

// // lib/rag.ts
// import fs from "fs";
// import path from "path";
// import { GoogleGenerativeAI } from "@google/generative-ai";

// // Gemini client
// const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// // Embedding model
// const EMBEDDING_MODEL = "models/text-embedding-004";

// export type KBEntry = {
//   id: string;
//   text: string;
//   source: string;
//   metadata: Record<string, any>;
//   embedding: number[];
// };

// let KB_CACHE: KBEntry[] | null = null;

// /* =======================
//      Load Knowledge Base
// ======================= */

// function loadKB(): KBEntry[] {
//   if (KB_CACHE) return KB_CACHE;

//   const kbPath = path.join(process.cwd(), "data", "knowledge_base.json");

//   if (!fs.existsSync(kbPath)) {
//     console.warn("[RAG] knowledge_base.json not found → returning empty context.");
//     KB_CACHE = [];
//     return KB_CACHE;
//   }

//   const raw = fs.readFileSync(kbPath, "utf8");
//   KB_CACHE = JSON.parse(raw) as KBEntry[];
//   return KB_CACHE;
// }

// /* =======================
//        Cosine Similarity
// ======================= */

// function cosineSim(a: number[], b: number[]): number {
//   let dot = 0;
//   let magA = 0;
//   let magB = 0;

//   const len = Math.min(a.length, b.length);

//   for (let i = 0; i < len; i++) {
//     dot += a[i] * b[i];
//     magA += a[i] * a[i];
//     magB += b[i] * b[i];
//   }

//   const denom = Math.sqrt(magA) * Math.sqrt(magB) || 1;
//   return dot / denom;
// }

// /* =======================
//     Embed User Question
// ======================= */

// async function embedQuery(text: string): Promise<number[]> {
//   const model = ai.getGenerativeModel({
//     model: EMBEDDING_MODEL, // "text-embedding-004"
//   });

//   const result = await model.embedContent(text);

//   return result.embedding.values;
// }

// /* =======================
//    Retrieve Matching Context
// ======================= */

// export async function retrieveRelevantContext(
//   query: string,
//   topK = 8
// ): Promise<KBEntry[]> {
//   const kb = loadKB();
//   if (!kb.length) return [];

//   const queryEmbedding = await embedQuery(query);
//   const qLower = query.toLowerCase();

//   const scored = kb.map((entry) => {
//     let score = cosineSim(queryEmbedding, entry.embedding || []);
//     const meta = entry.metadata || {};
//     const category = (meta.category || "").toString().toLowerCase();

//     // Small bonuses based on metadata matches
//     try {
//       if (meta.model_name) {
//         const m = String(meta.model_name).toLowerCase();
//         if (m && qLower.includes(m)) score += 0.06;
//       }
//       if (meta.product_id) {
//         const id = String(meta.product_id).toLowerCase();
//         if (id && qLower.includes(id)) score += 0.03;
//       }

//       if (entry.source === "price_sheet") {
//         // Miner-related queries
//         if (/s19|s21|m50|m60|whatsminer|mining|asic|hashrate|th\/s/i.test(query) &&
//             category === "miner") {
//           score += 0.05;
//         }

//         // Transformer-related queries
//         if (/transformer|kva|mva|padmount|wye|delta|tap/i.test(query) &&
//             category === "transformer") {
//           score += 0.06;
//         }

//         // Hosting-related queries
//         if (/hosting|colocation|colo|facility/i.test(query) &&
//             category === "hosting") {
//           score += 0.04;
//         }
//       }
//     } catch {
//       // ignore metadata problems
//     }

//     return { entry, score };
//   });

//   scored.sort((a, b) => b.score - a.score);

//   // Return top-K entries
//   return scored.slice(0, topK).map((s) => s.entry);
// }

