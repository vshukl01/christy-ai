import type { NextApiRequest, NextApiResponse } from "next";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { retrieveRelevantContext } from "@/lib/rag";
import { CHRISTY_SYSTEM_PROMPT } from "@/lib/systemPrompt";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const DEFAULT_MODEL = "gemini-2.0-flash";
const FALLBACK_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite", // if your project has it, it can be cheaper/quota-friendly
  "gemini-2.5-flash-lite",
];

const MAX_CONTEXT_CHARS = 7000;

function getGeminiClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY in server environment.");
  return new GoogleGenerativeAI(key);
}

function normalizeModelName(name: string) {
  const n = (name || "").trim();
  if (!n) return "";
  // Accept either "models/xyz" or "xyz"
  return n.startsWith("models/") ? n.replace("models/", "") : n;
}

function pickModelCandidates() {
  const envModel = normalizeModelName(process.env.GEMINI_MODEL || "");
  const candidates = [
    envModel || DEFAULT_MODEL,
    ...FALLBACK_MODELS.filter((m) => m !== envModel),
  ];
  // de-dupe
  return Array.from(new Set(candidates));
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt += 1;
      const status = err?.status;

      // Only retry rate-limit + transient errors
      const retryable = status === 429 || status === 500 || status === 503;

      if (!retryable || attempt > maxRetries) {
        throw err;
      }

      const retrySec = parseRetryDelaySeconds(err);
      const backoffMs =
        retrySec != null
          ? (retrySec + 1) * 1000
          : Math.min(60000, 1000 * Math.pow(2, attempt));

      console.warn(`⚠️ ${label} retry ${attempt}/${maxRetries} in ${Math.round(backoffMs / 1000)}s`);
      await sleep(backoffMs);
    }
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body || {};
    const messages = (body.messages || []) as ChatMessage[];

    if (!messages.length) return res.status(400).json({ error: "No messages provided" });

    const latest = messages[messages.length - 1];
    const userQuery = (latest?.content || "").trim();
    if (!userQuery) return res.status(400).json({ error: "Last message has no content" });

    // RAG context
    const contextEntries = await retrieveRelevantContext(userQuery);

    const contextTextRaw = contextEntries
      .map((e) => `Source: ${e.source}\n${e.text}`)
      .join("\n\n---\n\n");

    const contextText = truncate(contextTextRaw, MAX_CONTEXT_CHARS);

    // Convert history to Gemini format
    const history = messages.slice(0, -1).map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));

    const userPrompt = `
Use the following context to answer as Christy.

Rules:
- Use the context as the source of truth for pricing/stock/DOA.
- If pricing/stock is missing, say "Price on request" or "I can confirm stock".
- Ask 1–2 clarifying questions if needed (power rate, location, budget, hosting vs self-host).

Context:
${contextText || "(no matching context)"}

User question:
${userQuery}
`.trim();

    const ai = getGeminiClient();
    const candidates = pickModelCandidates();

    let lastErr: any = null;

    for (const modelName of candidates) {
      try {
        const model = ai.getGenerativeModel({
          model: modelName,
          systemInstruction: CHRISTY_SYSTEM_PROMPT,
        });

        const response = await withRetry(
          () =>
            model.generateContent({
              contents: [
                ...history,
                { role: "user", parts: [{ text: userPrompt }] },
              ],
            }),
          `generateContent(${modelName})`,
          6
        );

        const reply = response.response.text();
        return res.status(200).json({ reply, model: modelName });
      } catch (err: any) {
        lastErr = err;

        // If model is not found (404), try next candidate
        if (err?.status === 404) {
          console.warn(`⚠️ Model not found: ${modelName}. Trying next...`);
          continue;
        }

        // If quota is 0 / forbidden, this will keep failing across models.
        // We'll break early for clarity.
        if (err?.status === 429) {
          // still might succeed on next model if quota differs, so continue
          console.warn(`⚠️ Rate limited on ${modelName}. Trying next candidate...`);
          continue;
        }

        // Non-retryable → stop
        break;
      }
    }

    console.error("Christy API error:", lastErr);
    return res.status(500).json({
      error: "Internal server error",
      details: lastErr?.message ?? "Unknown error",
      hint:
        "If you see quota 'limit: 0', enable billing / quota for this API key project, or generate a new key in a project with Gemini API enabled.",
    });
  } catch (err: any) {
    console.error("Christy API fatal error:", err);
    return res.status(500).json({
      error: "Internal server error",
      details: err?.message ?? "Unknown error",
    });
  }
}

// // pages/api/chat.ts
// import type { NextApiRequest, NextApiResponse } from "next";
// import { GoogleGenerativeAI } from "@google/generative-ai";
// import { retrieveRelevantContext } from "@/lib/rag";
// import { CHRISTY_SYSTEM_PROMPT } from "@/lib/systemPrompt";

// type ChatMessage = {
//   role: "user" | "assistant";
//   content: string;
// };

// const DEFAULT_MODEL = "gemini-1.5-flash";
// const MAX_CONTEXT_CHARS = 7000;

// function getGeminiClient() {
//   const key = process.env.GEMINI_API_KEY;
//   if (!key) throw new Error("Missing GEMINI_API_KEY in server environment.");
//   return new GoogleGenerativeAI(key);
// }

// function pickModelName() {
//   const envModel = (process.env.GEMINI_MODEL || "").trim();
//   const normalized = envModel.startsWith("models/")
//     ? envModel.replace("models/", "")
//     : envModel;
//   return normalized || DEFAULT_MODEL;
// }

// function truncate(s: string, n: number) {
//   if (s.length <= n) return s;
//   return s.slice(0, n) + "…";
// }

// export default async function handler(req: NextApiRequest, res: NextApiResponse) {
//   if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

//   try {
//     const body = req.body || {};
//     const messages = (body.messages || []) as ChatMessage[];

//     if (!messages.length) return res.status(400).json({ error: "No messages provided" });

//     const latest = messages[messages.length - 1];
//     if (!latest.content?.trim()) {
//       return res.status(400).json({ error: "Last message has no content" });
//     }

//     const userQuery = latest.content.trim();

//     // ✅ RAG should never crash the endpoint
//     let contextEntries: any[] = [];
//     try {
//       contextEntries = await retrieveRelevantContext(userQuery);
//     } catch (e) {
//       console.warn("[/api/chat] retrieveRelevantContext failed:", (e as any)?.message || e);
//       contextEntries = [];
//     }

//     const contextTextRaw = contextEntries
//       .map((e) => `Source: ${e.source}\n${e.text}`)
//       .join("\n\n---\n\n");

//     const contextText = truncate(contextTextRaw, MAX_CONTEXT_CHARS);

//     const history = messages.slice(0, -1).map((m) => ({
//       role: m.role === "user" ? "user" : "model",
//       parts: [{ text: m.content }],
//     }));

//     const userPrompt = `
// Use the following context to answer as Christy.

// Rules:
// - Use the context as the source of truth for pricing/stock/DOA.
// - If pricing/stock is missing, say "Price on request" or "I can confirm stock".
// - Ask 1–2 clarifying questions if needed (power rate, location, budget, hosting vs self-host).
// - Be concise and action-oriented.

// Context:
// ${contextText || "(no matching context)"}

// User question:
// ${userQuery}
//     `.trim();

//     const ai = getGeminiClient();
//     const modelName = pickModelName();

//     const model = ai.getGenerativeModel({
//       model: modelName,
//       systemInstruction: CHRISTY_SYSTEM_PROMPT,
//     });

//     const response = await model.generateContent({
//       contents: [
//         ...history,
//         {
//           role: "user",
//           parts: [{ text: userPrompt }],
//         },
//       ],
//     });

//     const reply = response.response.text();

//     return res.status(200).json({
//       reply,
//       meta: {
//         model: modelName,
//         usedContextEntries: contextEntries.length,
//       },
//     });
//   } catch (err: any) {
//     console.error("Christy API error:", err);

//     return res.status(500).json({
//       error: "Internal server error",
//       details: err?.message ?? "Unknown error",
//     });
//   }
// }