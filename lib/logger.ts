import fs from "fs";
import path from "path";

const logsDir = path.join(process.cwd(), "logs");
const logFile = path.join(logsDir, "christy.log");

// Ensure folder exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

export function logEvent(event: string, data: any) {
  try {
    const timestamp = new Date().toISOString();
    const logEntry = `
[${timestamp}] ${event}
${JSON.stringify(data, null, 2)}
---------------------------------------
`;
    fs.appendFileSync(logFile, logEntry, "utf8");
  } catch (err) {
    console.error("Failed to write log", err);
  }
}
