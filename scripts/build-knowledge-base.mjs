// scripts/build-knowledge-base.mjs
// Christy AI — Build RAG Knowledge Base
// Inputs: data/rag/marketing_book.txt, data/rag/chats.json, data/rag/price_sheet.csv
// Output: data/rag/knowledge_base.json
//
// Fixes:
// - Batch embedding + throttling
// - Auto retry on 429 (rate limit) using retryDelay when available
// - Keeps everything "back to normal" (no log training, no pdf-parse)

import fs from "fs";
import path from "path";
import Papa from "papaparse";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config({ path: ".env.local" });

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("❌ Missing GEMINI_API_KEY. Add it to .env.local");
  process.exit(1);
}

const ai = new GoogleGenerativeAI(apiKey);

// Your folder layout
const RAG_DIR = path.join(process.cwd(), "data", "rag");
const OUT_PATH = path.join(RAG_DIR, "knowledge_base.json");

// Candidate embedding models
const EMBEDDING_MODEL_OVERRIDE = (process.env.EMBEDDING_MODEL || "").trim();
const EMBEDDING_MODEL_CANDIDATES = [
  "models/text-embedding-004",
  "models/gemini-embedding-001",
  "models/text-embedding-001",
  "models/embedding-001",
];

let SELECTED_EMBED_MODEL = null;

// Tuning
const CHUNK_MAX_CHARS = 800;

// Batch size matters a lot: fewer requests => fewer rate limit hits.
// Keep conservative (works well on free tier).
const EMBED_BATCH_SIZE = Number(process.env.EMBED_BATCH_SIZE || 16);

// Delay between batches (ms)
const BATCH_THROTTLE_MS = Number(process.env.EMBED_BATCH_DELAY_MS || 350);

// Max retry attempts when rate-limited
const MAX_RETRIES = Number(process.env.EMBED_MAX_RETRIES || 8);

/* ========== Small utilities ========== */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chunkText(text, maxChars = CHUNK_MAX_CHARS) {
  const paragraphs = String(text || "").split(/\n\s*\n/);
  const chunks = [];
  let current = "";

  for (const p of paragraphs) {
    const next = current ? `${current}\n\n${p}` : p;
    if (next.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = p;
    } else {
      current = next;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function parseRetryDelaySeconds(err) {
  // Google error payload sometimes has retryDelay like "31s"
  // err.errorDetails might include RetryInfo
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

async function withRetry(fn, label = "request") {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;

      const status = err?.status;
      const isRateLimit = status === 429;

      if (!isRateLimit || attempt > MAX_RETRIES) {
        console.error(`❌ ${label} failed (attempt ${attempt})`, err?.message || err);
        throw err;
      }

      const retrySec = parseRetryDelaySeconds(err);
      const backoffMs =
        retrySec != null
          ? (retrySec + 1) * 1000 // add 1s buffer
          : Math.min(60000, 1000 * Math.pow(2, attempt)); // exponential capped at 60s

      console.warn(
        `⚠️ Rate-limited (429) on ${label}. Retry attempt ${attempt}/${MAX_RETRIES} in ${Math.round(
          backoffMs / 1000
        )}s...`
      );

      await sleep(backoffMs);
    }
  }
}

async function tryEmbedOnce(modelName) {
  const model = ai.getGenerativeModel({ model: modelName });
  const resp = await model.embedContent("ping");
  const vec = resp?.embedding?.values || [];
  if (!Array.isArray(vec) || vec.length < 10) {
    throw new Error(`Invalid embedding vector from ${modelName}`);
  }
}

async function pickEmbeddingModel() {
  if (SELECTED_EMBED_MODEL) return SELECTED_EMBED_MODEL;

  if (EMBEDDING_MODEL_OVERRIDE) {
    await withRetry(() => tryEmbedOnce(EMBEDDING_MODEL_OVERRIDE), "embed ping");
    SELECTED_EMBED_MODEL = EMBEDDING_MODEL_OVERRIDE;
    return SELECTED_EMBED_MODEL;
  }

  for (const m of EMBEDDING_MODEL_CANDIDATES) {
    try {
      await withRetry(() => tryEmbedOnce(m), `embed ping (${m})`);
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

/**
 * Embed a batch in the MOST quota-efficient way:
 * 1) Prefer batch API if supported: embedContent({ content: { parts: [{text}] } }) for each item doesn't help.
 *    The Google SDK currently focuses on embedContent (single).
 *    So we implement a "client-side batch": we loop, but throttle + retry so it completes reliably.
 * 2) Optionally, we can "pack" multiple texts into one input separated by delimiters — NOT recommended for embeddings
 *    because you lose per-item vectors. So we keep one vector per text.
 */
async function embedBatch(texts) {
  if (!texts.length) return [];

  const modelName = await pickEmbeddingModel();
  const model = ai.getGenerativeModel({ model: modelName });

  const out = [];
  for (let i = 0; i < texts.length; i++) {
    const t = String(texts[i] || "");

    // Single embed call with retry
    const resp = await withRetry(() => model.embedContent(t), "embedContent");
    out.push(resp?.embedding?.values || []);

    // tiny delay every few calls to avoid burst throttling
    if ((i + 1) % 8 === 0) {
      await sleep(120);
    }
  }

  return out;
}

async function embedAll(texts) {
  // Process in chunks of EMBED_BATCH_SIZE with a delay between chunks
  const all = new Array(texts.length);

  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const end = Math.min(texts.length, start + EMBED_BATCH_SIZE);
    const slice = texts.slice(start, end);

    console.log(`Embedding ${start + 1}-${end} of ${texts.length}...`);

    const vecs = await embedBatch(slice);
    for (let j = 0; j < vecs.length; j++) {
      all[start + j] = vecs[j];
    }

    if (end < texts.length) {
      await sleep(BATCH_THROTTLE_MS);
    }
  }

  return all;
}

/* ========== Price row formatting ========== */

function describePriceRow(row) {
  const category = (row.category || "product").toString();
  const model = (row.model_name || "").toString();
  const condition =
    String(row.condition || "").toLowerCase() === "used" ? "used" : "new";

  const hashrate =
    row.hashrate_ths && String(row.hashrate_ths).trim()
      ? `Hashrate: ${row.hashrate_ths} TH/s`
      : "";

  const efficiency =
    row.efficiency_j_th && String(row.efficiency_j_th).trim()
      ? `Efficiency: ${row.efficiency_j_th} J/TH`
      : "";

  const price =
    row.price_usd && String(row.price_usd).trim()
      ? `$${row.price_usd}`
      : "Price on request";

  const stock =
    row.stock && String(row.stock).trim()
      ? `${row.stock} in stock`
      : "stock on request";

  const perf = [hashrate, efficiency].filter(Boolean).join(", ");

  let extra = "";
  const catLower = category.toLowerCase();
  if (catLower === "hosting") {
    extra =
      " Hosting applies ONLY to miners; transformers, containers, cables, PDUs/fans and spare parts are separate line items.";
  } else if (catLower === "transformer") {
    extra = " This is a power transformer for mining infrastructure, not a miner.";
  } else if (catLower === "container") {
    extra = " This is a mining container used to house and cool miners.";
  } else if (catLower === "immersion_system") {
    extra = " This is an immersion cooling system for miners, not a miner itself.";
  } else if (catLower === "cables") {
    extra = " These are power cables for connecting miners, PDUs, or transformers.";
  } else if (catLower === "pdu_fan" || catLower === "pdu" || catLower === "fan") {
    extra = " These are PDUs and/or fans that support mining deployments.";
  } else if (catLower === "parts" || catLower === "spare_parts" || catLower === "spares") {
    extra = " These are spare parts / replacement components.";
  }

  const doa =
    row.doa_terms && String(row.doa_terms).trim()
      ? ` DOA / warranty: ${row.doa_terms}`
      : "";

  const notes =
    row.notes && String(row.notes).trim() ? ` Notes: ${row.notes}` : "";

  return [
    `Category: ${category}`,
    `Model: ${model}`,
    `Condition: ${condition}`,
    perf && perf,
    `Price: ${price}`,
    `Availability: ${stock}.`,
    extra,
    doa,
    notes,
  ]
    .filter(Boolean)
    .join(" ");
}

/* ========== Build entries from files ========== */

async function buildMarketingEntries() {
  const filePath = path.join(RAG_DIR, "marketing_book.txt");
  if (!fs.existsSync(filePath)) {
    console.log("No marketing_book.txt found – skipping.");
    return [];
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return [];

  const chunks = chunkText(raw);
  const embeddings = await embedAll(chunks);

  return chunks.map((text, i) => ({
    id: `marketing_${i}`,
    text,
    source: "marketing_book",
    metadata: { section: i },
    embedding: embeddings[i],
  }));
}

async function buildChatEntries() {
  const filePath = path.join(RAG_DIR, "chats.json");
  if (!fs.existsSync(filePath)) {
    console.log("No chats.json found – skipping.");
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const chats = JSON.parse(raw);

  const texts = [];
  const metas = [];

  for (let i = 0; i < chats.length; i++) {
    const msg = chats[i];
    if (msg.role === "user" && chats[i + 1]?.role === "agent") {
      const combo = `User: ${msg.content}\nAgent: ${chats[i + 1].content}`;
      texts.push(combo);
      metas.push({
        type: "qa_pair",
        user_timestamp: msg.timestamp,
        agent_timestamp: chats[i + 1].timestamp,
      });
      i++;
    } else {
      texts.push(`${String(msg.role).toUpperCase()}: ${msg.content}`);
      metas.push({ type: "single_message", timestamp: msg.timestamp });
    }
  }

  const embeddings = await embedAll(texts);

  return texts.map((text, i) => ({
    id: `chat_${i}`,
    text,
    source: "chat",
    metadata: metas[i],
    embedding: embeddings[i],
  }));
}

async function buildPriceEntries() {
  const filePath = path.join(RAG_DIR, "price_sheet.csv");
  if (!fs.existsSync(filePath)) {
    console.log("No price_sheet.csv found – skipping.");
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });

  const rows = (parsed.data || []).filter(
    (row) => row && (row.product_id || row.model_name)
  );

  const texts = rows.map((row) => describePriceRow(row));
  const embeddings = await embedAll(texts);

  return rows.map((row, i) => ({
    id: `price_${row.product_id || i}`,
    text: texts[i],
    source: "price_sheet",
    metadata: row,
    embedding: embeddings[i],
  }));
}

/* ========== MAIN ========== */

async function main() {
  const embedModel = await pickEmbeddingModel();
  console.log(`✅ Embedding model selected: ${embedModel}`);
  console.log(
    `⚙️ Embed tuning: batchSize=${EMBED_BATCH_SIZE}, batchDelay=${BATCH_THROTTLE_MS}ms, maxRetries=${MAX_RETRIES}`
  );

  console.log("Building marketing KB...");
  const marketing = await buildMarketingEntries();

  console.log("Building chat KB...");
  const chats = await buildChatEntries();

  console.log("Building price sheet KB...");
  const prices = await buildPriceEntries();

  const kb = [...marketing, ...chats, ...prices];

  fs.writeFileSync(OUT_PATH, JSON.stringify(kb, null, 2), "utf8");
  console.log(`✅ Knowledge base saved to ${OUT_PATH} with ${kb.length} entries.`);
}

main().catch((err) => {
  console.error("❌ KB build failed:", err);
  process.exit(1);
});