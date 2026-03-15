const recommendForm = document.getElementById("recommendForm");
const recommendBtn = document.getElementById("recommendBtn");
const results = document.getElementById("results");
const emptyState = document.getElementById("emptyState");
const loadingState = document.getElementById("loadingState");
const resultsSummary = document.getElementById("resultsSummary");
const watchlistEl = document.getElementById("watchlist");
const watchlistEmpty = document.getElementById("watchlistEmpty");

const WATCHLIST_KEY = "movieWatchlist";

let currentRecommendations = [];
let watchlist = loadWatchlist();

renderWatchlist();

recommendForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const formData = getFormData();

  if (!formData.mood) {
    alert("Please select a mood.");
    return;
  }

  setLoading(true);
  clearResults();

  try {
    // For now use mock data.
    // Next step: replace this with fetch("/api/recommend", ...)
    const API_URL = "https://movie-recommendation-planner.vercel.app/api/recommend";

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(formData),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Failed to fetch recommendations");
  }

  const data = await response.json();
  const recommendations = data.recommendations || [];

    currentRecommendations = recommendations;
    renderResults(recommendations, formData);
  } catch (error) {
    console.error("Recommendation error:", error);
    resultsSummary.textContent = "Something went wrong while getting recommendations.";
    emptyState.classList.remove("hidden");
    emptyState.textContent = "Please try again.";
  } finally {
    setLoading(false);
  }
});

function getFormData() {
  const subscriptions = Array.from(
    document.querySelectorAll('input[name="subscriptions"]:checked')
  ).map((input) => input.value);

  return {
    mood: document.getElementById("mood").value,
    genre: document.getElementById("genre").value,
    language: document.getElementById("language").value,
    runtime: document.getElementById("runtime").value,
    familyFriendly: document.getElementById("familyFriendly").value,
    vibe: document.getElementById("vibe").value.trim(),
    subscriptions
  };
}

function setLoading(isLoading) {
  recommendBtn.disabled = isLoading;
  recommendBtn.textContent = isLoading ? "Finding Movies..." : "Recommend Movies";
  loadingState.classList.toggle("hidden", !isLoading);
  emptyState.classList.add("hidden");
}

function clearResults() {
  results.innerHTML = "";
}

function renderResults(movies, formData) {
  clearResults();

  if (!movies.length) {
    resultsSummary.textContent = "No recommendations found.";
    emptyState.classList.remove("hidden");
    emptyState.textContent = "Try changing your mood or genre.";
    return;
  }

  resultsSummary.textContent = `Showing ${movies.length} recommendations for a ${formData.mood} mood.`;
  emptyState.classList.add("hidden");

  movies.forEach((movie) => {
    const card = document.createElement("article");
    card.className = "movie-card";

    const isSaved = watchlist.some((item) => item.id === movie.id);

    card.innerHTML = `
      <img
        class="movie-poster"
        src="${movie.poster || 'https://via.placeholder.com/500x750?text=No+Poster'}"
        alt="${escapeHtml(movie.title)} poster"
        onerror="this.src='https://via.placeholder.com/500x750?text=No+Poster'"
      />

      <div class="movie-content">
        <h3>${escapeHtml(movie.title)} (${movie.year})</h3>
        <div class="movie-meta">${movie.genres.join(" • ")}</div>

        <div class="movie-overview">${escapeHtml(movie.overview)}</div>
        <div class="movie-why"><strong>Why it fits:</strong> ${escapeHtml(movie.whyRecommended)}</div>

        <div class="badges">
          ${movie.streaming.map((platform) => `<span class="badge">${escapeHtml(platform)}</span>`).join("")}
        </div>

        <div class="movie-actions">
          <button class="primary-btn save-btn" data-id="${movie.id}">
            ${isSaved ? "Saved to Watchlist" : "Add to Watchlist"}
          </button>
          <button class="secondary-btn refresh-btn" data-id="${movie.id}">
            Similar Pick
          </button>
        </div>
      </div>
    `;

    const saveBtn = card.querySelector(".save-btn");
    const refreshBtn = card.querySelector(".refresh-btn");

    saveBtn.addEventListener("click", () => {
      addToWatchlist(movie);
      saveBtn.textContent = "Saved to Watchlist";
      saveBtn.disabled = true;
    });

    refreshBtn.addEventListener("click", () => {
      alert(`Later, this button can fetch a similar movie to ${movie.title}.`);
    });

    if (isSaved) {
      saveBtn.disabled = true;
    }

    results.appendChild(card);
  });
}

function addToWatchlist(movie) {
  const alreadyExists = watchlist.some((item) => item.id === movie.id);
  if (alreadyExists) return;

  watchlist.unshift({
    ...movie,
    watched: false,
    savedAt: new Date().toISOString()
  });

  persistWatchlist();
  renderWatchlist();
}

function removeFromWatchlist(id) {
  watchlist = watchlist.filter((item) => item.id !== id);
  persistWatchlist();
  renderWatchlist();

  // Re-enable matching save button in current results if present
  const saveBtn = document.querySelector(`.save-btn[data-id="${id}"]`);
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.textContent = "Add to Watchlist";
  }
}

function toggleWatched(id) {
  watchlist = watchlist.map((item) => {
    if (item.id === id) {
      return { ...item, watched: !item.watched };
    }
    return item;
  });

  persistWatchlist();
  renderWatchlist();
}

function renderWatchlist() {
  watchlistEl.innerHTML = "";

  if (!watchlist.length) {
    watchlistEmpty.classList.remove("hidden");
    return;
  }

  watchlistEmpty.classList.add("hidden");

  watchlist.forEach((movie) => {
    const item = document.createElement("div");
    item.className = "watch-item";

    item.innerHTML = `
      <h4>${escapeHtml(movie.title)} (${movie.year})</h4>
      <p>
        ${escapeHtml(movie.genres.join(" • "))}<br />
        ${movie.streaming.length ? `Watch on: ${escapeHtml(movie.streaming.join(", "))}` : "Streaming info unavailable"}
      </p>
      <div class="watch-actions">
        <button class="secondary-btn watched-btn" data-id="${movie.id}">
          ${movie.watched ? "Watched ✓" : "Mark Watched"}
        </button>
        <button class="danger-btn remove-btn" data-id="${movie.id}">
          Remove
        </button>
      </div>
    `;

    item.querySelector(".watched-btn").addEventListener("click", () => {
      toggleWatched(movie.id);
    });

    item.querySelector(".remove-btn").addEventListener("click", () => {
      removeFromWatchlist(movie.id);
    });

    watchlistEl.appendChild(item);
  });
}

function loadWatchlist() {
  try {
    const stored = localStorage.getItem(WATCHLIST_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (error) {
    console.error("Failed to load watchlist:", error);
    return [];
  }
}

function persistWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
}

async function getMockRecommendations(formData) {
  await delay(900);

  const mood = formData.mood || "movie night";

  return [
    {
      id: "1",
      title: "The Secret Life of Walter Mitty",
      year: 2013,
      poster: "https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?auto=format&fit=crop&w=500&q=80",
      overview:
        "A quiet dreamer escapes routine life through a real-world adventure that becomes unexpectedly inspiring.",
      genres: ["Adventure", "Drama"],
      whyRecommended: `This fits your ${mood} mood because it feels hopeful, visually uplifting, and emotionally light without being shallow.`,
      streaming: prioritizePlatforms(["Netflix", "Prime Video"], formData.subscriptions)
    },
    {
      id: "2",
      title: "Chef",
      year: 2014,
      poster: "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=500&q=80",
      overview:
        "A chef rediscovers purpose, creativity, and connection while starting over in a more personal way.",
      genres: ["Comedy", "Drama"],
      whyRecommended: `A strong match for a ${mood} vibe because it is warm, comforting, and easy to enjoy after a long day.`,
      streaming: prioritizePlatforms(["Hulu", "Netflix"], formData.subscriptions)
    },
    {
      id: "3",
      title: "Palm Springs",
      year: 2020,
      poster: "https://images.unsplash.com/photo-1478720568477-152d9b164e26?auto=format&fit=crop&w=500&q=80",
      overview:
        "A clever and funny time-loop story that mixes romance, humor, and self-discovery.",
      genres: ["Comedy", "Romance", "Sci-Fi"],
      whyRecommended: `This one works well for a ${mood} mood because it is playful, emotionally satisfying, and never too heavy.`,
      streaming: prioritizePlatforms(["Hulu"], formData.subscriptions)
    }
  ];
}

function prioritizePlatforms(platforms, userSubscriptions) {
  if (!userSubscriptions || !userSubscriptions.length) return platforms;

  const matched = platforms.filter((p) => userSubscriptions.includes(p));
  const others = platforms.filter((p) => !userSubscriptions.includes(p));

  return [...matched, ...others];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
