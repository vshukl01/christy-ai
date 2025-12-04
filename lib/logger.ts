// lib/logger.ts
import fs from "fs";
import path from "path";

const LOG_PATH = path.join(process.cwd(), "logs", "christy.log");

// We never want to write to disk on Vercel / production – file system is read-only
const IS_SERVERLESS =
  process.env.VERCEL === "1" || process.env.NODE_ENV === "production";

function safeFileLog(line: string) {
  try {
    if (IS_SERVERLESS) {
      // In production / Vercel: just send to console so it appears in function logs
      console.log(line);
      return;
    }

    // Local dev: write to logs/christy.log
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch (err) {
    // Never let logging crash the app
    console.error("Logging failed:", err);
  }
}

export function logEvent(label: string, payload: any) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    label,
    payload,
  });

  safeFileLog(line);
}
