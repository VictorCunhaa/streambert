import { useState, useEffect, useMemo, useCallback } from "react";
import MediaCard from "../components/MediaCard";
import TrendingCarousel from "../components/TrendingCarousel";
import { PlayIcon, StarIcon } from "../components/Icons";
import { imgUrl, tmdbFetch } from "../utils/api";
import { useRatings, getRatingForItem } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";
import { storage } from "../utils/storage";
import { loadHomeLayout, loadHomeViewMode } from "../utils/homeLayout";

// ── Gêneros disponíveis na API do TMDB ───────────────────────────────────────
const GENRES = [
  { id: 28,    name: "Ação",             emoji: "💥", color: "#c0392b" },
  { id: 12,    name: "Aventura",         emoji: "🗺️", color: "#d35400" },
  { id: 16,    name: "Animação",         emoji: "🎨", color: "#8e44ad" },
  { id: 35,    name: "Comédia",          emoji: "😂", color: "#b8860b" },
  { id: 80,    name: "Crime",            emoji: "🕵️", color: "#2c3e50" },
  { id: 99,    name: "Documentário",     emoji: "🎬", color: "#2980b9" },
  { id: 18,    name: "Drama",            emoji: "🎭", color: "#6c3483" },
  { id: 10751, name: "Família",          emoji: "👨‍👩‍👧", color: "#1e8449" },
  { id: 14,    name: "Fantasia",         emoji: "🧙", color: "#5b2c6f" },
  { id: 27,    name: "Terror",           emoji: "👻", color: "#922b21" },
  { id: 10402, name: "Música",           emoji: "🎵", color: "#ad1457" },
  { id: 9648,  name: "Mistério",         emoji: "🔍", color: "#1a237e" },
  { id: 10749, name: "Romance",          emoji: "❤️", color: "#c2185b" },
  { id: 878,   name: "Ficção Científica",emoji: "🚀", color: "#0097a7" },
  { id: 53,    name: "Suspense",         emoji: "😱", color: "#37474f" },
  { id: 10752, name: "Guerra",           emoji: "⚔️", color: "#5d4037" },
  { id: 37,    name: "Faroeste",         emoji: "🤠", color: "#8d6e63" },
];

function getRecentHistoryItem(history) {
  if (!history || history.length === 0) return null;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = history.filter(
    (h) => h.watchedAt && h.watchedAt > sevenDaysAgo,
  );
  if (recent.length === 0) return null;
  return recent[Math.floor(Math.random() * recent.length)];
}

export default function HomePage({
  trending,
  trendingTV,
  loading,
  onSelect,
  progress,
  inProgress,
  offline,
  onRetry,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  history,
  apiKey,
  onGenreSelect,
}) {
  const hero = trending[0];

  const [similarItems, setSimilarItems] = useState([]);
  const [similarSource, setSimilarSource] = useState(null);
  const [topRatedItems, setTopRatedItems] = useState([]);

  // Load layout config (order + visibility) once on mount
  const [layout] = useState(() => loadHomeLayout());
  const { order: rowOrder, visible: rowVisible } = layout;

  const [viewMode] = useState(() => loadHomeViewMode());

  // All items for batch ratings fetch
  const allItems = useMemo(
    () => [
      ...inProgress,
      ...trending.map((i) => ({ ...i, media_type: "movie" })),
      ...trendingTV.map((i) => ({ ...i, media_type: "tv" })),
      ...similarItems,
      ...topRatedItems,
    ],
    [inProgress, trending, trendingTV, similarItems, topRatedItems],
  );

  const { ratingsMap, ageLimitSetting } = useRatings(allItems);

  const getRating = useCallback(
    (item) => getRatingForItem(item, ratingsMap),
    [ratingsMap],
  );
  const itemRestricted = useCallback(
    (item) =>
      isRestricted(getRatingForItem(item, ratingsMap).minAge, ageLimitSetting),
    [ratingsMap, ageLimitSetting],
  );

  // Enrich ratingsMap with restricted flag for carousels
  const enrichedRatingsMap = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(ratingsMap)) {
      out[k] = { ...v, restricted: isRestricted(v.minAge, ageLimitSetting) };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingsMap, ageLimitSetting]);

  // Fetch similar items based on recent watch history
  useEffect(() => {
    if (!apiKey || offline || !history || history.length === 0) return;
    const source = getRecentHistoryItem(history);
    if (!source) return;
    setSimilarSource(source);
    const type = source.media_type === "tv" ? "tv" : "movie";
    const tryFetch = (endpoint) =>
      tmdbFetch(`/${type}/${source.id}/${endpoint}`, apiKey).then((data) =>
        (data.results || [])
          .slice(0, 10)
          .map((item) => ({ ...item, media_type: type })),
      );
    tryFetch("similar")
      .then((results) => {
        if (results.length > 0) {
          setSimilarItems(results);
          return;
        }
        return tryFetch("recommendations").then(setSimilarItems);
      })
      .catch(() =>
        tryFetch("recommendations")
          .then(setSimilarItems)
          .catch(() => {}),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, offline, history?.length]);

  // Fetch top rated movies + TV, merge and shuffle
  useEffect(() => {
    if (!apiKey || offline) return;
    const controller = new AbortController();
    Promise.all([
      tmdbFetch("/movie/top_rated?page=1&region=BR", apiKey, {
        signal: controller.signal,
      }),
      tmdbFetch("/tv/top_rated?page=1&region=BR", apiKey, { signal: controller.signal }),
    ])
      .then(([moviesData, tvData]) => {
        const movies = (moviesData.results || [])
          .slice(0, 8)
          .map((i) => ({ ...i, media_type: "movie" }));
        const tv = (tvData.results || [])
          .slice(0, 8)
          .map((i) => ({ ...i, media_type: "tv" }));
        // Interleave movies and TV for variety
        const merged = [];
        const max = Math.max(movies.length, tv.length);
        for (let i = 0; i < max; i++) {
          if (movies[i]) merged.push(movies[i]);
          if (tv[i]) merged.push(tv[i]);
        }
        setTopRatedItems(merged);
      })
      .catch((e) => {
        if (e.name !== "AbortError") console.warn("Top rated fetch failed", e);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, offline]);

  // Stable pre-built item arrays for carousels, capped at 10
  const trendingMovieItems = useMemo(
    () => trending.slice(0, 10).map((i) => ({ ...i, media_type: "movie" })),
    [trending],
  );
  const trendingTVItems = useMemo(
    () => trendingTV.slice(0, 10).map((i) => ({ ...i, media_type: "tv" })),
    [trendingTV],
  );

  return (
    <div className="fade-in">
      {/* ── Offline ── */}
      {offline && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "60vh",
            gap: 16,
            color: "var(--text2)",
          }}
        >
          <div style={{ fontSize: 48 }}>📡</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)" }}>
            Sem conexão com a internet
          </div>
          <div style={{ fontSize: 14, color: "var(--text3)" }}>
            Em alta e busca requerem conexão com a internet. Seus downloads
            e biblioteca ainda funcionam offline.
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 8 }}
            onClick={onRetry}
          >
            Tentar novamente
          </button>
        </div>
      )}

      {!offline && loading && (
        <div className="loader">
          <div className="spinner" />
        </div>
      )}

      {/* ── Hero (always first) ── */}
      {!loading && hero && (
        <div className="hero">
          <div
            className="hero-bg"
            style={{
              backgroundImage: `url(${imgUrl(hero.backdrop_path, "original")})`,
            }}
          />
          <div className="hero-gradient" />
          <div className="hero-content">
            <div className="hero-type">Em Alta · Filme</div>
            <div className="hero-title">{hero.title || hero.name}</div>
            <div className="hero-meta">
              <span className="hero-rating">
                <StarIcon /> {hero.vote_average?.toFixed(1)}
              </span>
              <span>{hero.release_date?.slice(0, 4)}</span>
            </div>
            <div className="hero-overview">{hero.overview}</div>
            <div className="hero-actions">
                <button
                className="btn btn-primary"
                onClick={() => onSelect(hero)}
              >
                <PlayIcon /> Assistir Agora
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => onSelect(hero)}
              >
                Mais Informações
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Rows in user-configured order ── */}
      {rowOrder.map((id) => {
        if (!rowVisible[id]) return null;

        if (id === "continue") {
          if (inProgress.length === 0) return null;
          return (
            <div key="continue" className="section">
              <div className="section-title">Continuar Assistindo</div>
              <div className="cards-grid">
                {inProgress.map((item) => {
                  const pk =
                    item.media_type === "movie"
                      ? `movie_${item.id}`
                      : `tv_${item.id}_s${item.season}e${item.episode}`;
                  const r = getRating(item);
                  const restr = itemRestricted(item);
                  return (
                    <MediaCard
                      key={`${item.media_type}_${item.id}`}
                      item={item}
                      onClick={() => onSelect(item)}
                      progress={progress[pk] || 0}
                      watched={watched}
                      onMarkWatched={onMarkWatched}
                      onMarkUnwatched={onMarkUnwatched}
                      ageRating={r.cert}
                      restricted={restr}
                    />
                  );
                })}
              </div>
            </div>
          );
        }

        // Render a section as a flat cards-grid (list view)
        const renderList = (key, title, titleHighlight, items) => {
          if (!items || items.length === 0) return null;
          return (
            <div key={key} className="section">
              <div className="section-title">
                {titleHighlight ? (
                  <>
                    {title}&nbsp;
                    <span style={{ color: "var(--red)" }}>
                      {titleHighlight}
                    </span>
                  </>
                ) : (
                  title
                )}
              </div>
              <div className="cards-grid">
                {items.map((item) => {
                  const type = item.media_type === "tv" ? "tv" : "movie";
                  const rk = `${type}_${item.id}`;
                  const rd = enrichedRatingsMap[rk] || {};
                  return (
                    <MediaCard
                      key={`${item.media_type}_${item.id}`}
                      item={item}
                      onClick={() => onSelect(item)}
                      progress={0}
                      watched={watched}
                      onMarkWatched={onMarkWatched}
                      onMarkUnwatched={onMarkUnwatched}
                      ageRating={rd.cert}
                      restricted={rd.restricted}
                    />
                  );
                })}
              </div>
            </div>
          );
        };

        if (id === "similar") {
          if (!similarSource || similarItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "similar",
              "Similar a",
              similarSource.title || similarSource.name,
              similarItems,
            );
          return (
            <TrendingCarousel
              key="similar"
              items={similarItems}
              title="Similar a"
              titleHighlight={similarSource.title || similarSource.name}
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        if (id === "trendingMovies") {
          if (trendingMovieItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "trendingMovies",
              "Em Alta - Filmes",
              null,
              trendingMovieItems,
            );
          return (
            <TrendingCarousel
              key="trendingMovies"
              items={trendingMovieItems}
              title="Em Alta - Filmes"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        if (id === "trendingTV") {
          if (trendingTVItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "trendingTV",
              "Em Alta - Séries",
              null,
              trendingTVItems,
            );
          return (
            <TrendingCarousel
              key="trendingTV"
              items={trendingTVItems}
              title="Em Alta - Séries"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        if (id === "topRated") {
          if (topRatedItems.length === 0) return null;
          if (viewMode === "list")
            return renderList("topRated", "Mais Bem Avaliados", null, topRatedItems);
          return (
            <TrendingCarousel
              key="topRated"
              items={topRatedItems}
              title="Mais Bem Avaliados"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          );
        }

        return null;
      })}

      {/* ── Explore por Gêneros ──────────────────────────────────────────── */}
      {!offline && !loading && onGenreSelect && (
        <div className="section">
          <div className="section-title">
            Explore por&nbsp;
            <span style={{ color: "var(--red)" }}>Gêneros</span>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))",
              gap: 12,
            }}
          >
            {GENRES.map((genre) => (
              <button
                key={genre.id}
                onClick={() =>
                  onGenreSelect(genre.id, genre.name, genre.emoji, genre.color)
                }
                style={{
                  padding: "18px 12px 14px",
                  background: `linear-gradient(145deg, ${genre.color}33, ${genre.color}11)`,
                  border: `1px solid ${genre.color}44`,
                  borderRadius: 12,
                  color: "var(--text)",
                  cursor: "pointer",
                  fontFamily: "var(--font-body)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  transition: "transform 0.18s, box-shadow 0.18s, border-color 0.18s, background 0.18s",
                  boxShadow: "0 2px 12px rgba(0,0,0,0.35)",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = "translateY(-3px) scale(1.03)";
                  e.currentTarget.style.boxShadow = `0 8px 24px ${genre.color}44`;
                  e.currentTarget.style.borderColor = `${genre.color}99`;
                  e.currentTarget.style.background = `linear-gradient(145deg, ${genre.color}55, ${genre.color}22)`;
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = "none";
                  e.currentTarget.style.boxShadow = "0 2px 12px rgba(0,0,0,0.35)";
                  e.currentTarget.style.borderColor = `${genre.color}44`;
                  e.currentTarget.style.background = `linear-gradient(145deg, ${genre.color}33, ${genre.color}11)`;
                }}
              >
                <span style={{ fontSize: 28, lineHeight: 1 }}>
                  {genre.emoji}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    textAlign: "center",
                    color: "var(--text)",
                    lineHeight: 1.2,
                  }}
                >
                  {genre.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
