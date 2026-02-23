// pages/api/chat.ts

import type { NextApiRequest, NextApiResponse } from "next";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { retrieveRelevantContext } from "@/lib/rag";
import { CHRISTY_SYSTEM_PROMPT } from "@/lib/systemPrompt";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const DEFAULT_MODEL = "gemini-1.5-flash";
const MAX_CONTEXT_CHARS = 7000;

function getGeminiClient() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("Missing GEMINI_API_KEY in server environment.");
  }
  return new GoogleGenerativeAI(key);
}

function pickModelName() {
  const envModel = (process.env.GEMINI_MODEL || "").trim();
  const normalized = envModel.startsWith("models/")
    ? envModel.replace("models/", "")
    : envModel;
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

    // Retrieve relevant RAG context
    const contextEntries = await retrieveRelevantContext(userQuery);

    const contextTextRaw = contextEntries
      .map((e) => `Source: ${e.source}\n${e.text}`)
      .join("\n\n---\n\n");

    const contextText = truncate(contextTextRaw, MAX_CONTEXT_CHARS);

    // Build history for model
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
    const modelName = pickModelName();

    const model = ai.getGenerativeModel({
      model: modelName,
      systemInstruction: CHRISTY_SYSTEM_PROMPT,
    });

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

    return res.status(200).json({ reply });
  } catch (err: any) {
    console.error("Christy API error:", err);

    return res.status(500).json({
      error: "Internal server error",
      details: err?.message ?? "Unknown error",
    });
  }
}