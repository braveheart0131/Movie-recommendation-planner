import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  // Basic CORS so your GitHub Pages frontend can call this Vercel backend
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      mood = "",
      genre = "",
      language = "",
      runtime = "",
      familyFriendly = "",
      vibe = "",
      subscriptions = [],
    } = req.body || {};

    if (!mood) {
      return res.status(400).json({ error: "Mood is required." });
    }

    const safeSubscriptions = Array.isArray(subscriptions)
      ? subscriptions.filter(Boolean).slice(0, 10)
      : [];

    const prompt = buildPrompt({
      mood,
      genre,
      language,
      runtime,
      familyFriendly,
      vibe,
      subscriptions: safeSubscriptions,
    });

    const response = await client.responses.create({
      model: "gpt-5.4",
      input: prompt,
    });

    const rawText = response.output_text?.trim();

    if (!rawText) {
      return res.status(500).json({
        error: "The model returned an empty response.",
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseError) {
      return res.status(500).json({
        error: "Failed to parse model response as JSON.",
        raw: rawText,
      });
    }

    if (
      !parsed ||
      !Array.isArray(parsed.recommendations) ||
      parsed.recommendations.length === 0
    ) {
      return res.status(500).json({
        error: "No recommendations returned from model.",
        raw: parsed,
      });
    }

    // Normalize shape for the frontend
    const normalized = parsed.recommendations.slice(0, 6).map((movie, index) => ({
      id: String(movie.id || `${movie.title || "movie"}-${movie.year || index}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
      title: movie.title || "Unknown Title",
      year: Number(movie.year) || null,
      poster: movie.poster || "",
      overview: movie.overview || "Overview not available yet.",
      genres: Array.isArray(movie.genres) ? movie.genres : [],
      whyRecommended:
        movie.whyRecommended ||
        movie.short_reason ||
        "This movie matches your preferences.",
      streaming: Array.isArray(movie.streaming) ? movie.streaming : [],
    }));

    return res.status(200).json({
      recommendations: normalized,
    });
  } catch (error) {
    console.error("Recommendation error:", error);

    return res.status(500).json({
      error: "Failed to generate recommendations.",
      details: error?.message || "Unknown server error",
    });
  }
}

function buildPrompt({
  mood,
  genre,
  language,
  runtime,
  familyFriendly,
  vibe,
  subscriptions,
}) {
  return `
You are an expert movie recommendation assistant.

Your job:
- Recommend 6 movies only
- Match the user's mood and preferences closely
- Prefer real, well-known movies
- Do NOT recommend TV shows or series
- Avoid duplicates
- Keep explanations concise and helpful
- Prefer movies likely to be available on the user's subscriptions when possible
- Return valid JSON only
- Do not include markdown fences
- Do not include any text before or after the JSON

User preferences:
- Mood: ${mood || "Any"}
- Genre: ${genre || "Any"}
- Language: ${language || "Any"}
- Runtime: ${runtime || "Any"}
- Family friendly: ${familyFriendly || "No preference"}
- Extra vibe: ${vibe || "None"}
- Streaming subscriptions: ${subscriptions.length ? subscriptions.join(", ") : "None provided"}

Return this exact JSON shape:
{
  "recommendations": [
    {
      "title": "Movie title",
      "year": 2014,
      "poster": "",
      "overview": "1-2 sentence overview",
      "genres": ["Drama", "Comedy"],
      "whyRecommended": "1-2 sentence explanation of why this fits the user's mood and preferences",
      "streaming": ["Netflix", "Hulu"]
    }
  ]
}

Rules:
- "poster" can be an empty string for now
- "streaming" can be an empty array if uncertain
- "overview" should be short and accurate
- "whyRecommended" must sound personalized to the input
- Output valid JSON only
`.trim();
}
