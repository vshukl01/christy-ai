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

// Gemini client
const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

// Default model
const MODEL = process.env.GEMINI_MODEL || "models/gemini-2.5-flash";

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

    logEvent("User Query", latest);

    // Retrieve relevant RAG context
    const contextEntries = await retrieveRelevantContext(userQuery);

    const contextText = contextEntries
      .map((e) => `Source: ${e.source}\n${e.text}`)
      .join("\n\n---\n\n");

    // Build history for model
    const history = messages.slice(0, -1).map((m) => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.content }],
    }));

    // Construct user prompt
    const userPrompt = `
Use the following context to answer as Christy.

Context:
${contextText || "(no matching context)"}

User question:
${userQuery}
    `.trim();

    // Call Gemini 2.5
    const model = ai.getGenerativeModel({
      model: MODEL,
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

    // Log Christy response
    logEvent("Christy Response", {
      reply,
      contextUsed: contextEntries.map((e) => ({
        id: e.id,
        source: e.source,
      })),
    });

    return res.status(200).json({ reply });
  } catch (err: any) {
    console.error("Christy API error:", err);

    logEvent("Error", {
      message: err?.message || "Unknown error",
      stack: err?.stack,
    });

    return res.status(500).json({
      error: "Internal server error",
      details: err?.message ?? "Unknown error",
    });
  }
}
