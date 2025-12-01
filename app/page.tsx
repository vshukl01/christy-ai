"use client";

import { useState, useRef, useEffect, type FormEvent } from "react";

const CUSTOMER_NAME = "Ved"; // change this if you want to demo with another name

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export default function HomePage() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content: `Hi ${CUSTOMER_NAME}, Hope yopu are having a Great Day today, I’m Christy. I can help you pick the right Bitcoin miner, transformers, containers, cables, PDUs and fans – plus hosting options for miners. How can I help you today?`,
    },
  ]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  async function sendMessage(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const newMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: trimmed },
    ];

    setMessages(newMessages);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: newMessages }),
      });

      const data: { reply?: string; error?: string } = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Request failed");
      }

      setMessages([
        ...newMessages,
        { role: "assistant", content: data.reply || "…" },
      ]);
    } catch (err) {
      console.error("Chat error:", err);
      setMessages([
        ...newMessages,
        {
          role: "assistant",
          content:
            "Sorry, something went wrong talking to Christy. Please try again.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="chat-shell">
        <header className="chat-header">
          <div className="header-left">
            <h1>Christy – BTC Mining Agent</h1>
            <p>
              Ask about hardware, transformers, containers, cables, PDUs/fans,
              ROI or hosting. Christy uses your playbook, past chats, and the
              live price sheet.
            </p>
            <ul className="feature-list">
              <li>Bitcoin miner suggestions</li>
              <li>ROI &amp; payback calculations</li>
              <li>Dynamic price lookup from inventory</li>
              <li>Hosting vs home mining comparison (miners only)</li>
              <li>Mining profitability modeling</li>
            </ul>
          </div>

          <div className="header-right">
            <div className="agent-name">Christy Solberg</div>
            <span className="status-pill">
              <span className="status-dot" />
              Online
            </span>
          </div>
        </header>

        <main className="chat-window">
          {messages.map((m, idx) => (
            <div
              key={idx}
              className={`message-row ${
                m.role === "user"
                  ? "message-row-user"
                  : "message-row-assistant"
              }`}
            >
              <div className="avatar">{m.role === "user" ? "You" : "C"}</div>
              <div className="bubble">
                {m.content.split("\n").map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            </div>
          ))}

          {loading && (
            <div className="message-row message-row-assistant">
              <div className="avatar">C</div>
              <div className="bubble bubble-loading">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </main>

        <form className="chat-input-bar" onSubmit={sendMessage}>
          <input
            type="text"
            value={input}
            placeholder="Type your question for Christy (e.g. $4k budget, 8¢/kWh, home mining)…"
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !input.trim()}>
            {loading ? "Sending..." : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}
