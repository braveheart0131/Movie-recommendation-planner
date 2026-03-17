import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", "true");
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
      freePlatforms = [],
      includeFree = false,
    } = req.body || {};

    if (!mood) {
      return res.status(400).json({ error: "Mood is required." });
    }

    if (!process.env.TMDB_BEARER_TOKEN) {
      return res.status(500).json({
        error: "TMDB_BEARER_TOKEN is missing in environment variables.",
      });
    }

    const prompt = `
You are a movie recommendation assistant.

For each movie, explicitly explain how it matches the user's mood, and ensure all recommendations are clearly different from each other in tone, pacing, or theme.

Avoid obvious or overused recommendations unless they are an exceptional fit.

Return valid JSON only. Do not include markdown.

Recommend 6 real movies for this user.

User preferences:
- Mood: ${mood || "Any"}
- Genre: ${genre || "Any"}
- Language: ${language || "Any"}
- Runtime: ${runtime || "Any"}
- Family friendly: ${familyFriendly || "No preference"}
- Extra vibe: ${vibe || "None"}
- Streaming subscriptions: ${
      Array.isArray(subscriptions) && subscriptions.length
        ? subscriptions.join(", ")
        : "None provided"
    }
- Include free streaming options: ${includeFree ? "Yes" : "No"}
- Preferred free platforms: ${
  Array.isArray(freePlatforms) && freePlatforms.length
    ? freePlatforms.join(", ")
    : "None provided"
}
- If free streaming options are allowed, prefer movies available on the user's selected free platforms when possible.

Return this exact JSON shape:
{
  "recommendations": [
    {
      "title": "Movie title",
      "year": 2014,
      "whyRecommended": "Why this fits the user",
      "streaming": ["Netflix"]
    }
  ]
}
`.trim();

    const aiResponse = await client.responses.create({
      model: "gpt-5-mini",
      input: prompt,
    });

    const text = aiResponse.output_text?.trim();

    if (!text) {
      return res.status(500).json({ error: "Empty response from OpenAI" });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      console.error("AI JSON parse failed:", text);
      return res.status(500).json({
        error: "Model returned invalid JSON",
        raw: text,
      });
    }

    const aiRecommendations = Array.isArray(parsed.recommendations)
      ? parsed.recommendations.slice(0, 6)
      : [];

    const enriched = await Promise.all(
      aiRecommendations.map((movie, index) =>
        enrichWithTMDB(movie, index, subscriptions, freePlatforms, includeFree)
      )
    );

    return res.status(200).json({
      recommendations: enriched.filter(Boolean),
    });
  } catch (error) {
    console.error("API error:", error);

    return res.status(500).json({
      error: "Failed to generate recommendations",
      details: error.message || "Unknown error",
    });
  }
}

async function enrichWithTMDB(movie, index, userSubscriptions = [], freePlatforms = [], includeFree = false) {
  const title = movie?.title?.trim();
  const year = movie?.year;

  if (!title) return null;

  const searchMatch = await searchTMDBMovie(title, year);
  if (!searchMatch) {
    return {
      id: slugify(`${title}-${year || index}`),
      title,
      year: year || null,
      poster: "",
      overview: "Overview unavailable.",
      genres: [],
      whyRecommended:
        movie.whyRecommended || "This movie matches your preferences.",
      streaming: Array.isArray(movie.streaming) ? movie.streaming : [],
    };
  }

  const details = await getTMDBMovieDetails(searchMatch.id);
  const providers = extractUSFlatrateProviders(details?.["watch/providers"]);

  const streaming = prioritizeProviders(providers, userSubscriptions,freePlatforms, includeFree);

  return {
    id: String(searchMatch.id),
    title: details?.title || title,
    year: getYear(details?.release_date) || year || null,
    poster: details?.poster_path
      ? `${TMDB_IMAGE_BASE}${details.poster_path}`
      : "",
    overview: details?.overview || "Overview unavailable.",
    genres: Array.isArray(details?.genres)
      ? details.genres.map((g) => g.name)
      : [],
    whyRecommended:
      movie.whyRecommended || "This movie matches your preferences.",
    streaming,
  };
}

async function searchTMDBMovie(title, year) {
  const url = new URL(`${TMDB_BASE_URL}/search/movie`);
  url.searchParams.set("query", title);
  if (year) url.searchParams.set("year", String(year));
  url.searchParams.set("include_adult", "false");

  const res = await fetch(url.toString(), {
    headers: tmdbHeaders(),
  });

  if (!res.ok) {
    throw new Error(`TMDB search failed: ${res.status}`);
  }

  const data = await res.json();
  return data?.results?.[0] || null;
}

async function getTMDBMovieDetails(movieId) {
  const url = new URL(`${TMDB_BASE_URL}/movie/${movieId}`);
  url.searchParams.set("append_to_response", "watch/providers");

  const res = await fetch(url.toString(), {
    headers: tmdbHeaders(),
  });

  if (!res.ok) {
    throw new Error(`TMDB details failed: ${res.status}`);
  }

  return res.json();
}

function tmdbHeaders() {
  return {
    accept: "application/json",
    Authorization: `Bearer ${process.env.TMDB_BEARER_TOKEN}`,
  };
}

function extractUSFlatrateProviders(watchProviders) {
  const us = watchProviders?.results?.US;
  const flatrate = us?.flatrate || [];
  return flatrate.map((p) => p.provider_name).filter(Boolean);
}

function prioritizeProviders(
  providers,
  userSubscriptions = [],
  freePlatforms = [],
  includeFree = false
) {
  if (!Array.isArray(providers)) return [];

  const paidMatches = providers.filter((p) => userSubscriptions.includes(p));
  const freeMatches = includeFree
    ? providers.filter((p) => freePlatforms.includes(p))
    : [];
  const others = providers.filter(
    (p) => !paidMatches.includes(p) && !freeMatches.includes(p)
  );

  return [...paidMatches, ...freeMatches, ...others];
}

function formatProviders(providers, freePlatforms = []) {
  return providers.map((p) =>
    freePlatforms.includes(p) ? `${p} (Free)` : p
  );
}

function getYear(dateString) {
  if (!dateString) return null;
  return Number(String(dateString).slice(0, 4)) || null;
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
