import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TMDB_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
const CANDIDATE_COUNT = 12;
const FINAL_COUNT = 6;

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
    } = req.body || {};

    const subscriptions = Array.isArray(req.body?.subscriptions)
      ? req.body.subscriptions.map((v) => String(v).trim()).filter(Boolean)
      : [];

    const freePlatforms = Array.isArray(req.body?.freePlatforms)
      ? req.body.freePlatforms.map((v) => String(v).trim()).filter(Boolean)
      : [];

    const includeFree = Boolean(req.body?.includeFree);

    if (!mood) {
      return res.status(400).json({ error: "Mood is required." });
    }

    if (!process.env.TMDB_BEARER_TOKEN) {
      return res.status(500).json({
        error: "TMDB_BEARER_TOKEN is missing in environment variables.",
      });
    }

    const prompt = buildPrompt({
      mood,
      genre,
      language,
      runtime,
      familyFriendly,
      vibe,
      subscriptions,
      freePlatforms,
      includeFree,
    });

    const aiResponse = await client.responses.create({
      model: "gpt-5-mini",
      input: prompt,
    });

    const text = aiResponse.output_text?.trim();

    if (!text) {
      return res.status(500).json({ error: "Empty response from OpenAI" });
    }

    const parsed = safeParseJson(text);
    if (!parsed) {
      console.error("AI JSON parse failed:", text);
      return res.status(500).json({
        error: "Model returned invalid JSON",
        raw: text,
      });
    }

    const aiRecommendations = Array.isArray(parsed.recommendations)
      ? dedupeCandidates(parsed.recommendations).slice(0, CANDIDATE_COUNT)
      : [];

    if (!aiRecommendations.length) {
      return res.status(500).json({
        error: "Model returned no recommendations",
      });
    }

    const enriched = await Promise.all(
      aiRecommendations.map((movie, index) =>
        enrichWithTMDB(movie, index, {
          mood,
          genre,
          language,
          runtime,
          familyFriendly,
          vibe,
          subscriptions,
          freePlatforms,
          includeFree,
        })
      )
    );

    const ranked = enriched
      .filter(Boolean)
      .sort((a, b) => b._score - a._score)
      .slice(0, FINAL_COUNT)
      .map(stripInternalFields);

    return res.status(200).json({
      recommendations: ranked,
    });
  } catch (error) {
    console.error("API error:", error);

    return res.status(500).json({
      error: "Failed to generate recommendations",
      details: error.message || "Unknown error",
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
  freePlatforms,
  includeFree,
}) {
  return `
You are a movie recommendation assistant.

Return valid JSON only. Do not include markdown, comments, or extra text.
Recommend ${CANDIDATE_COUNT} real movies for this user.

The goal is to provide a diverse but highly relevant candidate pool.
Do NOT repeat the same kind of movie over and over.
Mix popular and slightly less obvious picks when relevant.
Prefer strong-fit movies over generic "safe" picks.

User preferences:
- Mood: ${mood || "Any"}
- Genre: ${genre || "Any"}
- Language: ${language || "Any"}
- Runtime: ${runtime || "Any"}
- Family friendly: ${familyFriendly || "No preference"}
- Extra vibe: ${vibe || "None"}

Platform preferences:
- Paid subscriptions: ${subscriptions.length ? subscriptions.join(", ") : "none"}
- Free platforms allowed: ${includeFree ? "Yes" : "No"}
- Allowed free platforms: ${
    includeFree && freePlatforms.length ? freePlatforms.join(", ") : "none"
  }

Important:
- These platform preferences are only a preference signal.
- Return strong movie candidates even if platform certainty is imperfect.
- Do not invent fake movies.
- Keep "whyRecommended" short and specific.

Return this exact JSON shape:
{
  "recommendations": [
    {
      "title": "Movie title",
      "year": 2014,
      "whyRecommended": "Why this fits the user"
    }
  ]
}
`.trim();
}

async function enrichWithTMDB(movie, index, userPrefs) {
  const title = movie?.title?.trim();
  const year = movie?.year;

  if (!title) return null;

  const searchMatch = await searchTMDBMovie(title, year);
  if (!searchMatch) return null;

  const details = await getTMDBMovieDetails(searchMatch.id);
  const providers = extractUSProviders(details?.["watch/providers"]);

  const matchedStreaming = prioritizeProviders(
    providers,
    userPrefs.subscriptions,
    userPrefs.freePlatforms,
    userPrefs.includeFree
  );

  if (!matchedStreaming.length) {
    return null;
  }

  const enrichedMovie = {
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
      movie?.whyRecommended || "This movie matches your preferences.",
    streaming: matchedStreaming.map((p) => p.name),
    _score: scoreMovie({
      movie,
      details,
      matchedStreaming,
      userPrefs,
      index,
    }),
  };

  return enrichedMovie;
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

function extractUSProviders(watchProviders) {
  const us = watchProviders?.results?.US || {};

  const flatrate = Array.isArray(us.flatrate)
    ? us.flatrate.map((p) => ({ ...p, accessType: "paid" }))
    : [];

  const free = Array.isArray(us.free)
    ? us.free.map((p) => ({ ...p, accessType: "free" }))
    : [];

  const ads = Array.isArray(us.ads)
    ? us.ads.map((p) => ({ ...p, accessType: "free" }))
    : [];

  const combined = [...flatrate, ...free, ...ads];

  const seen = new Set();
  return combined
    .filter((p) => p?.provider_name)
    .filter((p) => {
      const key = normalizePlatformName(p.provider_name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p) => ({
      id: p.provider_id,
      name: p.provider_name,
      normalized: normalizePlatformName(p.provider_name),
      accessType: p.accessType,
    }));
}

function prioritizeProviders(
  providers,
  userSubscriptions = [],
  freePlatforms = [],
  includeFree = false
) {
  if (!Array.isArray(providers)) return [];

  const paidMatches = providers.filter(
    (p) =>
      p.accessType === "paid" &&
      matchPlatform(p.name, userSubscriptions)
  );

  const freeMatches = includeFree
    ? providers.filter(
        (p) =>
          p.accessType === "free" &&
          matchPlatform(p.name, freePlatforms)
      )
    : [];

  return [...paidMatches, ...freeMatches];
}

function scoreMovie({ movie, details, matchedStreaming, userPrefs, index }) {
  let score = 0;

  // Strongly prefer subscription matches over free matches.
  const paidCount = matchedStreaming.filter((p) => p.accessType === "paid").length;
  const freeCount = matchedStreaming.filter((p) => p.accessType === "free").length;

  score += paidCount * 10;
  score += freeCount * 4;

  // Slight bonus for movies available on multiple matched platforms.
  score += matchedStreaming.length;

  // Genre match bonus.
  const requestedGenre = String(userPrefs.genre || "").trim().toLowerCase();
  const tmdbGenres = Array.isArray(details?.genres)
    ? details.genres.map((g) => String(g.name || "").toLowerCase())
    : [];

  if (requestedGenre && tmdbGenres.some((g) => g.includes(requestedGenre))) {
    score += 4;
  }

  // Language match bonus.
  const requestedLanguage = String(userPrefs.language || "").trim().toLowerCase();
  const originalLanguage = String(details?.original_language || "").toLowerCase();

  if (requestedLanguage) {
    const langMap = {
      english: "en",
      hindi: "hi",
      spanish: "es",
      korean: "ko",
      japanese: "ja",
      french: "fr",
      german: "de",
      italian: "it",
      tamil: "ta",
      telugu: "te",
      malayalam: "ml",
    };

    const requestedCode = langMap[requestedLanguage] || requestedLanguage;
    if (originalLanguage === requestedCode) {
      score += 3;
    }
  }

  // Family-friendly bonus/penalty.
  if (String(userPrefs.familyFriendly).toLowerCase() === "yes") {
    const isAdult = Boolean(details?.adult);
    score += isAdult ? -8 : 3;
  }

  // Runtime preference bonus.
  const runtimePref = String(userPrefs.runtime || "").toLowerCase();
  const runtimeValue = Number(details?.runtime || 0);

  if (runtimePref && runtimeValue) {
    if (
      runtimePref.includes("short") &&
      runtimeValue > 0 &&
      runtimeValue <= 100
    ) {
      score += 2;
    } else if (
      runtimePref.includes("medium") &&
      runtimeValue >= 90 &&
      runtimeValue <= 130
    ) {
      score += 2;
    } else if (
      runtimePref.includes("long") &&
      runtimeValue > 130
    ) {
      score += 2;
    }
  }

  // Prefer better-rated titles slightly, but don't let this dominate.
  const voteAverage = Number(details?.vote_average || 0);
  score += Math.min(voteAverage, 10);

  // Small preference for earlier AI-ranked items.
  score += Math.max(0, CANDIDATE_COUNT - index) * 0.15;

  // Small reward for specific recommendation text.
  if (movie?.whyRecommended && movie.whyRecommended.length > 30) {
    score += 1;
  }

  return score;
}

function matchPlatform(providerName, allowedList) {
  const provider = normalizePlatformName(providerName);

  return allowedList.some((item) => {
    const allowed = normalizePlatformName(item);
    if (!allowed) return false;
    return provider === allowed || provider.includes(allowed) || allowed.includes(provider);
  });
}

function normalizePlatformName(name) {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "";

  const aliases = {
    netflix: "netflix",
    hulu: "hulu",
    "max": "max",
    "hbo max": "max",
    "amazon prime video": "prime video",
    "prime video": "prime video",
    "amazon video": "prime video",
    "disney plus": "disney+",
    "disney+": "disney+",
    "apple tv plus": "apple tv+",
    "apple tv+": "apple tv+",
    "paramount plus": "paramount+",
    "paramount+": "paramount+",
    peacock: "peacock",
    "youtube premium": "youtube premium",
    tubi: "tubi",
    pluto: "pluto tv",
    "pluto tv": "pluto tv",
    freevee: "freevee",
    "amazon freevee": "freevee",
    crunchyroll: "crunchyroll",
    mubi: "mubi",
  };

  return aliases[raw] || raw;
}

function getYear(dateString) {
  if (!dateString) return null;
  return Number(String(dateString).slice(0, 4)) || null;
}

function stripInternalFields(movie) {
  const { _score, ...clean } = movie;
  return clean;
}

function dedupeCandidates(recommendations) {
  const seen = new Set();

  return recommendations.filter((movie) => {
    const key = `${String(movie?.title || "").trim().toLowerCase()}-${movie?.year || ""}`;
    if (!movie?.title || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    const sliced = text.slice(firstBrace, lastBrace + 1);

    try {
      return JSON.parse(sliced);
    } catch {
      return null;
    }
  }
}
