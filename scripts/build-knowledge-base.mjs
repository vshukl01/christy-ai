// scripts/build-knowledge-base.mjs

import fs from "fs";
import path from "path";
import Papa from "papaparse";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Load env (GEMINI_API_KEY, etc.)
dotenv.config({ path: ".env.local" });

const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// Embedding model
const EMBEDDING_MODEL = "models/text-embedding-004";

/* ========== Helper Functions ========== */

function chunkText(text, maxChars = 800) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = []; // plain JS array
  let current = "";

  for (const p of paragraphs) {
    if ((current + "\n\n" + p).length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = p;
    } else {
      current += (current ? "\n\n" : "") + p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function embedBatch(texts) {
  if (!texts.length) return [];

  const model = ai.getGenerativeModel({ model: EMBEDDING_MODEL });

  const embeddings = [];
  for (const t of texts) {
    const resp = await model.embedContent(t);
    embeddings.push(resp.embedding.values || []);
  }

  return embeddings;
}

/* ========== Log Parsing Helpers (NEW) ========== */

// Split log into blocks separated by dashed lines
function splitLogBlocks(raw) {
  return raw
    .split(/-+\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function maskPII(text = "") {
  // email
  text = text.replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "[EMAIL]");
  // phone (loose)
  text = text.replace(/\b(\+?\d[\d\-\(\)\s]{7,}\d)\b/g, "[PHONE]");
  return text;
}

// Optional: tag episodes to improve retrieval later
function inferLogTags(text) {
  const t = (text || "").toLowerCase();
  const tags = [];

  if (t.includes("hosting") || t.includes("kwh")) tags.push("hosting");
  if (t.includes("doa") || t.includes("warranty")) tags.push("warranty");
  if (t.includes("ship") || t.includes("delivery")) tags.push("shipping");
  if (t.includes("price") || t.includes("cheap") || t.includes("$/t"))
    tags.push("pricing");
  if (t.includes("stock") || t.includes("available") || t.includes("in stock"))
    tags.push("availability");
  if (t.includes("invoice")) tags.push("invoice");
  if (t.includes("hold") || t.includes("reserve")) tags.push("hold");
  if (t.includes("used") || t.includes("refurb")) tags.push("used_hardware");

  return tags;
}

/**
 * Parse logs/christy.log to paired episodes:
 *  - [ts] User Query {json}
 *  - [ts] Christy Response {json}
 */
function parseChristyLog(raw) {
  const blocks = splitLogBlocks(raw);

  const headerRe =
    /^\[(?<ts>.+?)\]\s+(?<kind>User Query|Christy Response)\s*\n(?<json>[\s\S]+)$/;

  let pendingUser = null;
  const episodes = [];

  for (const b of blocks) {
    const m = b.match(headerRe);
    if (!m || !m.groups) continue;

    const ts = m.groups.ts;
    const kind = m.groups.kind;
    const jsonText = m.groups.json.trim();

    const obj = safeJsonParse(jsonText);
    if (!obj) continue;

    if (kind === "User Query") {
      pendingUser = { ts, obj };
      continue;
    }

    if (kind === "Christy Response") {
      if (!pendingUser) continue;

      const userText = maskPII(pendingUser.obj?.content || "");
      const agentText = maskPII(obj?.reply || "");

      // Skip low-signal
      if (!userText.trim() && !agentText.trim()) {
        pendingUser = null;
        continue;
      }

      const combined = `User: ${userText}\nAgent: ${agentText}`;
      const tags = inferLogTags(combined);

      episodes.push({
        user_ts: pendingUser.ts,
        agent_ts: ts,
        user_text: userText,
        agent_text: agentText,
        combined,
        contextUsed: obj?.contextUsed || [],
        tags,
      });

      pendingUser = null;
    }
  }

  return episodes;
}

/**
 * Turn a price sheet row into a human-readable description string for RAG.
 * The CSV has:
 * product_id, model_name, category, condition, is_used,
 * hashrate_ths, efficiency_j_th, price_usd, stock, doa_terms, notes
 */
function describePriceRow(row) {
  const category = (row.category || "product").toString();
  const model = (row.model_name || "").toString();

  const condition = row.condition === "used" ? "used" : "new";

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

  // Extra category-specific hints
  let extra = "";
  if (category === "hosting") {
    extra =
      " Hosting applies ONLY to miners; transformers, containers, cables, PDUs and fans are separate line items.";
  } else if (category === "transformer") {
    extra = " This is a power transformer for mining infrastructure, not a miner.";
  } else if (category === "container") {
    extra = " This is a mining container used to house and cool miners.";
  } else if (category === "immersion_system") {
    extra =
      " This is an immersion cooling system (e.g., Submer tank) for miners, not a miner itself.";
  } else if (category === "cables") {
    extra = " These are power cables for connecting miners or PDUs.";
  } else if (category === "pdu_fan") {
    extra = " PDUs and/or fans that support miner deployments.";
  }

  // DOA / warranty
  let doa = "";
  if (row.doa_terms && String(row.doa_terms).trim()) {
    doa = ` DOA / warranty: ${row.doa_terms}`;
  }

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

/* ========== Marketing Book Entries ========== */

async function buildMarketingEntries() {
  const filePath = path.join(process.cwd(), "data", "marketing_book.txt");

  if (!fs.existsSync(filePath)) {
    console.log("No marketing_book.txt found – skipping marketing KB entries.");
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    console.log("marketing_book.txt is empty – skipping marketing KB entries.");
    return [];
  }

  const chunks = chunkText(raw);
  const embeddings = await embedBatch(chunks);

  return chunks.map((text, i) => ({
    id: `marketing_${i}`,
    text,
    source: "marketing_book",
    metadata: { section: i },
    embedding: embeddings[i],
  }));
}

/* ========== Past Chat Entries ========== */

async function buildChatEntries() {
  const filePath = path.join(process.cwd(), "data", "chats.json");

  if (!fs.existsSync(filePath)) {
    console.log("No chats.json found – skipping chat KB entries.");
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

  const embeddings = await embedBatch(texts);

  return texts.map((text, i) => ({
    id: `chat_${i}`,
    text,
    source: "chat",
    metadata: metas[i],
    embedding: embeddings[i],
  }));
}

/* ========== Christy Logs Entries (NEW) ========== */

async function buildLogEntries() {
  const filePath = path.join(process.cwd(), "logs", "christy.log");

  if (!fs.existsSync(filePath)) {
    console.log("No logs/christy.log found – skipping log KB entries.");
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    console.log("logs/christy.log is empty – skipping log KB entries.");
    return [];
  }

  const episodes = parseChristyLog(raw);

  if (!episodes.length) {
    console.log("No log episodes parsed – skipping log KB entries.");
    return [];
  }

  const texts = [];
  const metas = [];

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];

    // chunk large agent replies safely
    const baseUser = `User: ${ep.user_text}`;
    const agentChunks = chunkText(`Agent: ${ep.agent_text}`, 900);

    if (agentChunks.length <= 1) {
      texts.push(ep.combined);
      metas.push({
        type: "log_qa_pair",
        user_timestamp: ep.user_ts,
        agent_timestamp: ep.agent_ts,
        tags: ep.tags,
        contextUsed: ep.contextUsed,
      });
    } else {
      for (let c = 0; c < agentChunks.length; c++) {
        texts.push(`${baseUser}\n${agentChunks[c]}`);
        metas.push({
          type: "log_qa_pair_chunk",
          user_timestamp: ep.user_ts,
          agent_timestamp: ep.agent_ts,
          chunk_index: c,
          chunk_total: agentChunks.length,
          tags: ep.tags,
          contextUsed: ep.contextUsed,
        });
      }
    }
  }

  const embeddings = await embedBatch(texts);

  return texts.map((text, i) => ({
    id: `log_${i}`,
    text,
    source: "christy_log",
    metadata: metas[i],
    embedding: embeddings[i],
  }));
}

/* ========== Price Sheet Entries (CSV) ========== */

async function buildPriceEntries() {
  const filePath = path.join(process.cwd(), "data", "price_sheet.csv");

  if (!fs.existsSync(filePath)) {
    console.log("No price_sheet.csv found – skipping price KB entries.");
    return [];
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });

  const rows = (parsed.data || []).filter(
    (row) => row && (row.product_id || row.model_name)
  );

  const texts = rows.map((row) => describePriceRow(row));
  const embeddings = await embedBatch(texts);

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
  console.log("Building marketing KB...");
  const marketing = await buildMarketingEntries();

  console.log("Building chat KB...");
  const chats = await buildChatEntries();

  console.log("Building log KB (christy.log)...");
  const logs = await buildLogEntries();

  console.log("Building price sheet KB...");
  const prices = await buildPriceEntries();

  const kb = [...marketing, ...chats, ...logs, ...prices];

  const outPath = path.join(process.cwd(), "data", "knowledge_base.json");
  fs.writeFileSync(outPath, JSON.stringify(kb, null, 2), "utf8");

  console.log(`Knowledge base saved to ${outPath} with ${kb.length} entries.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});



// // scripts/build-knowledge-base.mjs

// import fs from "fs";
// import path from "path";
// import Papa from "papaparse";
// import dotenv from "dotenv";
// import { GoogleGenerativeAI } from "@google/generative-ai";

// // Load env (GEMINI_API_KEY, etc.)
// dotenv.config({ path: ".env.local" });

// const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// // Embedding model
// const EMBEDDING_MODEL = "models/text-embedding-004";

// /* ========== Helper Functions ========== */

// function chunkText(text, maxChars = 800) {
//   const paragraphs = text.split(/\n\s*\n/);
//   const chunks = [];           // <- plain JS array, no : string[]
//   let current = "";

//   for (const p of paragraphs) {
//     if ((current + "\n\n" + p).length > maxChars) {
//       if (current.trim()) chunks.push(current.trim());
//       current = p;
//     } else {
//       current += (current ? "\n\n" : "") + p;
//     }
//   }
//   if (current.trim()) chunks.push(current.trim());
//   return chunks;
// }

// async function embedBatch(texts) {
//   if (!texts.length) return [];

//   const model = ai.getGenerativeModel({ model: EMBEDDING_MODEL });

//   const embeddings = [];

//   for (const t of texts) {
//     // simplest / safest signature: pass raw text
//     const resp = await model.embedContent(t);
//     embeddings.push(resp.embedding.values || []);
//   }

//   return embeddings;
// }


// /**
//  * Turn a price sheet row into a human-readable description string for RAG.
//  * The CSV has:
//  * product_id, model_name, category, condition, is_used,
//  * hashrate_ths, efficiency_j_th, price_usd, stock, doa_terms, notes
//  */
// function describePriceRow(row) {
//   const category = (row.category || "product").toString();
//   const model = (row.model_name || "").toString();

//   const condition = row.condition === "used" ? "used" : "new";

//   const hashrate =
//     row.hashrate_ths && String(row.hashrate_ths).trim()
//       ? `Hashrate: ${row.hashrate_ths} TH/s`
//       : "";

//   const efficiency =
//     row.efficiency_j_th && String(row.efficiency_j_th).trim()
//       ? `Efficiency: ${row.efficiency_j_th} J/TH`
//       : "";

//   const price =
//     row.price_usd && String(row.price_usd).trim()
//       ? `$${row.price_usd}`
//       : "Price on request";

//   const stock =
//     row.stock && String(row.stock).trim()
//       ? `${row.stock} in stock`
//       : "stock on request";

//   const perf = [hashrate, efficiency].filter(Boolean).join(", ");

//   // Extra category-specific hints
//   let extra = "";
//   if (category === "hosting") {
//     extra =
//       " Hosting applies ONLY to miners; transformers, containers, cables, PDUs and fans are separate line items.";
//   } else if (category === "transformer") {
//     extra =
//       " This is a power transformer for mining infrastructure, not a miner.";
//   } else if (category === "container") {
//     extra = " This is a mining container used to house and cool miners.";
//   } else if (category === "immersion_system") {
//     extra =
//       " This is an immersion cooling system (e.g., Submer tank) for miners, not a miner itself.";
//   } else if (category === "cables") {
//     extra = " These are power cables for connecting miners or PDUs.";
//   } else if (category === "pdu_fan") {
//     extra = " PDUs and/or fans that support miner deployments.";
//   }

//   // DOA / warranty
//   let doa = "";
//   if (row.doa_terms && String(row.doa_terms).trim()) {
//     doa = ` DOA / warranty: ${row.doa_terms}`;
//   }

//   const notes =
//     row.notes && String(row.notes).trim()
//       ? ` Notes: ${row.notes}`
//       : "";

//   return [
//     `Category: ${category}`,
//     `Model: ${model}`,
//     `Condition: ${condition}`,
//     perf && perf,
//     `Price: ${price}`,
//     `Availability: ${stock}.`,
//     extra,
//     doa,
//     notes,
//   ]
//     .filter(Boolean)
//     .join(" ");
// }

// /* ========== Marketing Book Entries ========== */

// async function buildMarketingEntries() {
//   const filePath = path.join(process.cwd(), "data", "marketing_book.txt");

//   if (!fs.existsSync(filePath)) {
//     console.log("No marketing_book.txt found – skipping marketing KB entries.");
//     return [];
//   }

//   const raw = fs.readFileSync(filePath, "utf8");
//   if (!raw.trim()) {
//     console.log("marketing_book.txt is empty – skipping marketing KB entries.");
//     return [];
//   }

//   const chunks = chunkText(raw);
//   const embeddings = await embedBatch(chunks);

//   return chunks.map((text, i) => ({
//     id: `marketing_${i}`,
//     text,
//     source: "marketing_book",
//     metadata: { section: i },
//     embedding: embeddings[i],
//   }));
// }

// /* ========== Past Chat Entries ========== */

// async function buildChatEntries() {
//   const filePath = path.join(process.cwd(), "data", "chats.json");

//   if (!fs.existsSync(filePath)) {
//     console.log("No chats.json found – skipping chat KB entries.");
//     return [];
//   }

//   const raw = fs.readFileSync(filePath, "utf8");
//   const chats = JSON.parse(raw);

//   const texts = [];
//   const metas = [];

//   for (let i = 0; i < chats.length; i++) {
//     const msg = chats[i];

//     if (msg.role === "user" && chats[i + 1]?.role === "agent") {
//       const combo = `User: ${msg.content}\nAgent: ${chats[i + 1].content}`;
//       texts.push(combo);
//       metas.push({
//         type: "qa_pair",
//         user_timestamp: msg.timestamp,
//         agent_timestamp: chats[i + 1].timestamp,
//       });
//       i++;
//     } else {
//       texts.push(`${String(msg.role).toUpperCase()}: ${msg.content}`);
//       metas.push({ type: "single_message", timestamp: msg.timestamp });
//     }
//   }

//   const embeddings = await embedBatch(texts);

//   return texts.map((text, i) => ({
//     id: `chat_${i}`,
//     text,
//     source: "chat",
//     metadata: metas[i],
//     embedding: embeddings[i],
//   }));
// }

// /* ========== Price Sheet Entries (CSV) ========== */

// async function buildPriceEntries() {
//   const filePath = path.join(process.cwd(), "data", "price_sheet.csv");

//   if (!fs.existsSync(filePath)) {
//     console.log("No price_sheet.csv found – skipping price KB entries.");
//     return [];
//   }

//   const raw = fs.readFileSync(filePath, "utf8");
//   const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });

//   const rows = (parsed.data || []).filter(
//     (row) => row && (row.product_id || row.model_name)
//   );

//   const texts = rows.map((row) => describePriceRow(row));
//   const embeddings = await embedBatch(texts);

//   return rows.map((row, i) => ({
//     id: `price_${row.product_id || i}`,
//     text: texts[i],
//     source: "price_sheet",
//     metadata: row,
//     embedding: embeddings[i],
//   }));
// }

// /* ========== MAIN ========== */

// async function main() {
//   console.log("Building marketing KB...");
//   const marketing = await buildMarketingEntries();

//   console.log("Building chat KB...");
//   const chats = await buildChatEntries();

//   console.log("Building price sheet KB...");
//   const prices = await buildPriceEntries();

//   const kb = [...marketing, ...chats, ...prices];

//   const outPath = path.join(process.cwd(), "data", "knowledge_base.json");
//   fs.writeFileSync(outPath, JSON.stringify(kb, null, 2), "utf8");

//   console.log(`Knowledge base saved to ${outPath} with ${kb.length} entries.`);
// }

// main().catch((err) => {
//   console.error(err);
//   process.exit(1);
// });
