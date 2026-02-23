// pages/api/chat.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { retrieveRelevantContext } from "@/lib/rag";
import { CHRISTY_SYSTEM_PROMPT } from "@/lib/systemPrompt";
import { logEvent } from "@/lib/logger";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

// ✅ Use a widely available model by default.
// Your current default "models/gemini-2.5-flash" is likely not enabled for your key.
const DEFAULT_MODEL = "gemini-1.5-flash";

// Keep prompts safe to avoid Gemini failures on long context
const MAX_CONTEXT_CHARS = 7000;

function getGeminiClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error(
      "Missing GEMINI_API_KEY in server environment. Add it to Vercel Env Vars and .env.local."
    );
  }
  return new GoogleGenerativeAI(key);
}

function pickModelName() {
  // Allow env override, but fallback to safe default
  const envModel = (process.env.GEMINI_MODEL || "").trim();

  // Accept either "gemini-1.5-flash" OR "models/gemini-1.5-flash" style,
  // normalize to the form expected by the SDK.
  const normalized =
    envModel.startsWith("models/") ? envModel.replace("models/", "") : envModel;

  return normalized || DEFAULT_MODEL;
}

function truncate(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const messages = (body.messages || []) as ChatMessage[];

    if (!messages.length) {
      return res.status(400).json({ error: "No messages provided" });
    }

    const latest = messages[messages.length - 1];

    if (!latest.content?.trim()) {
      return res.status(400).json({ error: "Last message has no content" });
    }

    const userQuery = latest.content.trim();

    // Log user query
    logEvent("User Query", latest);

    // Retrieve relevant RAG context
    const contextEntries = await retrieveRelevantContext(userQuery);

    // Build context text
    const contextTextRaw = contextEntries
      .map((e) => `Source: ${e.source}\n${e.text}`)
      .join("\n\n---\n\n");

    // ✅ Keep context compact
    const contextText = truncate(contextTextRaw, MAX_CONTEXT_CHARS);

    // Build history for model (Gemini expects "user" and "model")
    const history = messages.slice(0, -1).map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));

    // Construct user prompt
    const userPrompt = `
Use the following context to answer as Christy.

Rules:
- Use the context as the source of truth for pricing/stock/DOA.
- If pricing/stock is missing, say "Price on request" or "I can confirm stock".
- Keep it helpful and concise.
- Ask 1–2 clarifying questions if needed (power rate, location, budget, hosting vs self-host).

Context:
${contextText || "(no matching context)"}

User question:
${userQuery}
    `.trim();

    const ai = getGeminiClient();

    // ✅ Use safe model name (no "models/" prefix here)
    const modelName = pickModelName();

    const model = ai.getGenerativeModel({
      model: modelName,
      systemInstruction: CHRISTY_SYSTEM_PROMPT,
    });

    // Call Gemini
    const response = await model.generateContent({
      contents: [
        ...history,
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
    });

    const reply = response.response.text();

    // Log Christy response
    logEvent("Christy Response", {
      reply,
      contextUsed: contextEntries.map((e) => ({
        id: e.id,
        source: e.source,
      })),
      model: modelName,
    });

    return res.status(200).json({ reply });
  } catch (err: any) {
    console.error("Christy API error:", err);

    // Better error visibility in logs
    logEvent("Error", {
      message: err?.message || "Unknown error",
      name: err?.name,
      stack: err?.stack,
      // Some Gemini errors include extra fields:
      status: err?.status,
      statusText: err?.statusText,
    });

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
// import { logEvent } from "@/lib/logger";

// type ChatMessage = {
//   role: "user" | "assistant";
//   content: string;
// };

// // Gemini client
// const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// // Default model
// const MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash";

// export default async function handler(
//   req: NextApiRequest,
//   res: NextApiResponse
// ) {
//   if (req.method !== "POST") {
//     return res.status(405).json({ error: "Method not allowed" });
//   }

//   try {
//     const body = req.body || {};
//     const messages = (body.messages || []) as ChatMessage[];

//     if (!messages.length) {
//       return res.status(400).json({ error: "No messages provided" });
//     }

//     const latest = messages[messages.length - 1];

//     if (!latest.content?.trim()) {
//       return res.status(400).json({ error: "Last message has no content" });
//     }

//     const userQuery = latest.content.trim();

//     logEvent("User Query", latest);

//     // Retrieve relevant RAG context
//     const contextEntries = await retrieveRelevantContext(userQuery);

//     const contextText = contextEntries
//       .map((e) => `Source: ${e.source}\n${e.text}`)
//       .join("\n\n---\n\n");

//     // Build history for model
//     const history = messages.slice(0, -1).map((m) => ({
//       role: m.role === "user" ? "user" : "model",
//       parts: [{ text: m.content }],
//     }));

//     // Construct user prompt
//     const userPrompt = `
// Use the following context to answer as Christy.

// Context:
// ${contextText || "(no matching context)"}

// User question:
// ${userQuery}
//     `.trim();

//     // Call Gemini 2.5
//     const model = ai.getGenerativeModel({
//       model: MODEL,
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

//     // Log Christy response
//     logEvent("Christy Response", {
//       reply,
//       contextUsed: contextEntries.map((e) => ({
//         id: e.id,
//         source: e.source,
//       })),
//     });

//     return res.status(200).json({ reply });
//   } catch (err: any) {
//     console.error("Christy API error:", err);

//     logEvent("Error", {
//       message: err?.message || "Unknown error",
//       stack: err?.stack,
//     });

//     return res.status(500).json({
//       error: "Internal server error",
//       details: err?.message ?? "Unknown error",
//     });
//   }
// }
