import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const apiKey = process.env.GEMINI_API_KEY;

async function listModels() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

  try {
    const res = await fetch(url);
    const json = await res.json();

    console.log("\n=== AVAILABLE MODELS ===\n");
    json.models?.forEach((m) => console.log(m.name));
    console.log("\n========================\n");

  } catch (err) {
    console.error("Error listing models:", err);
  }
}

listModels();

