import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import MediaCard from "../components/MediaCard";
import TrendingCarousel from "../components/TrendingCarousel";
import { imgUrl, tmdbFetch } from "../utils/api";
import { useRatings } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";

// ── Opções de ordenação para a listagem completa ──────────────────────────────
const SORT_OPTIONS = [
  {
    id: "relevance",
    label: "Relevância",
    api: "vote_count.desc",
    extra: "",
  },
  {
    id: "popularity",
    label: "Popularidade",
    api: "popularity.desc",
    extra: "",
  },
  {
    id: "rating",
    label: "Mais Avaliados",
    api: "vote_average.desc",
    extra: "&vote_count.gte=200",
  },
  {
    id: "newest",
    label: "Mais Recentes",
    api: "release_date.desc",
    extra: "&vote_count.gte=10",
  },
  {
    id: "az",
    label: "A-Z",
    api: "original_title.asc",
    extra: "",
  },
];

export default function GenrePage({
  genreId,
  genreName,
  genreEmoji,
  genreColor,
  apiKey,
  onSelect,
  watched,
  onMarkWatched,
  onMarkUnwatched,
}) {
  const [topMonth, setTopMonth] = useState([]);
  const [topSpotlight, setTopSpotlight] = useState([]);
  const [loading, setLoading] = useState(true);

  // Listagem completa
  const [sortId, setSortId] = useState("relevance");
  const [listItems, setListItems] = useState([]);
  const [listLoading, setListLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Refs para paginação sem stale closures
  const listRef = useRef({ page: 0, totalPages: 1, loading: false, sortId: "relevance" });
  const sentinelRef = useRef(null);

  // ── Fetch inicial: Top do Mês + Em Destaque ───────────────────────────────
  useEffect(() => {
    if (!apiKey) return;
    let mounted = true;

    setLoading(true);
    setTopMonth([]);
    setTopSpotlight([]);

    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const dateStr = sixMonthsAgo.toISOString().split("T")[0];

    Promise.all([
      tmdbFetch(
        `/discover/movie?sort_by=popularity.desc&with_genres=${genreId}&primary_release_date.gte=${dateStr}&page=1`,
        apiKey,
      ),
      tmdbFetch(
        `/discover/movie?sort_by=vote_average.desc&vote_count.gte=200&with_genres=${genreId}&page=1`,
        apiKey,
      ),
    ])
      .then(([monthData, spotlightData]) => {
        if (!mounted) return;
        setTopMonth(
          (monthData.results || [])
            .slice(0, 10)
            .map((i) => ({ ...i, media_type: "movie" })),
        );
        setTopSpotlight(
          (spotlightData.results || [])
            .slice(0, 10)
            .map((i) => ({ ...i, media_type: "movie" })),
        );
        setLoading(false);
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [apiKey, genreId]);

  // ── Fetch da listagem ao mudar gênero ou ordenação ────────────────────────
  useEffect(() => {
    if (!apiKey) return;
    let mounted = true;

    const sort = SORT_OPTIONS.find((s) => s.id === sortId);

    // Reset do estado de paginação
    listRef.current = { page: 0, totalPages: 1, loading: true, sortId };
    setListItems([]);
    setHasMore(true);
    setListLoading(true);

    tmdbFetch(
      `/discover/movie?sort_by=${sort.api}&with_genres=${genreId}${sort.extra}&page=1`,
      apiKey,
    )
      .then((data) => {
        if (!mounted) return;
        const results = (data.results || []).map((i) => ({
          ...i,
          media_type: "movie",
        }));
        const totalPages = Math.min(data.total_pages || 1, 25);
        listRef.current = { page: 1, totalPages, loading: false, sortId };
        setListItems(results);
        setHasMore(1 < totalPages);
        setListLoading(false);
      })
      .catch(() => {
        if (!mounted) return;
        listRef.current.loading = false;
        setListLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [apiKey, genreId, sortId]);

  // ── Carrega próxima página ────────────────────────────────────────────────
  const loadNextPage = useCallback(() => {
    const s = listRef.current;
    if (s.loading || s.page >= s.totalPages || s.sortId !== sortId) return;

    s.loading = true;
    setListLoading(true);

    const sort = SORT_OPTIONS.find((o) => o.id === sortId);

    tmdbFetch(
      `/discover/movie?sort_by=${sort.api}&with_genres=${genreId}${sort.extra}&page=${s.page + 1}`,
      apiKey,
    )
      .then((data) => {
        const results = (data.results || []).map((i) => ({
          ...i,
          media_type: "movie",
        }));
        s.page += 1;
        s.loading = false;
        setListItems((prev) => [...prev, ...results]);
        setHasMore(s.page < s.totalPages);
        setListLoading(false);
      })
      .catch(() => {
        s.loading = false;
        setListLoading(false);
      });
  }, [apiKey, genreId, sortId]);

  // ── IntersectionObserver para scroll infinito ─────────────────────────────
  // Deps:
  //  • loadNextPage  — recreia quando genreId/sortId muda
  //  • loading       — o sentinela só entra no DOM quando loading=false;
  //                    sem essa dep o observer é criado antes do sentinela existir
  //  • listItems.length — recria após cada página carregada; garante disparo
  //                       imediato se o sentinela ainda estiver visível
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const scrollRoot = document.querySelector(".main");

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadNextPage();
      },
      { root: scrollRoot, rootMargin: "400px" },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadNextPage, loading, listItems.length]);

  // ── Ratings ───────────────────────────────────────────────────────────────
  const allItems = useMemo(
    () => [...topMonth, ...topSpotlight, ...listItems],
    [topMonth, topSpotlight, listItems],
  );

  const { ratingsMap, ageLimitSetting } = useRatings(allItems);

  const enrichedRatingsMap = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(ratingsMap)) {
      out[k] = { ...v, restricted: isRestricted(v.minAge, ageLimitSetting) };
    }
    return out;
  }, [ratingsMap, ageLimitSetting]);

  const heroItem = topMonth[0] || topSpotlight[0];

  return (
    <div className="fade-in">
      {/* ── Genre Hero ─────────────────────────────────────────────────── */}
      <div className="hero" style={{ height: 320 }}>
        {heroItem?.backdrop_path && (
          <div
            className="hero-bg"
            style={{
              backgroundImage: `url(${imgUrl(heroItem.backdrop_path, "original")})`,
            }}
          />
        )}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: heroItem?.backdrop_path
              ? `linear-gradient(135deg, ${genreColor}55 0%, transparent 60%)`
              : `linear-gradient(135deg, ${genreColor}99, #0a0a0a)`,
          }}
        />
        <div className="hero-gradient" />
        <div className="hero-content" style={{ gap: 8 }}>
          <div className="hero-type">Explorando por Gênero</div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 48, lineHeight: 1 }}>{genreEmoji}</span>
            <div
              className="hero-title"
              style={{ fontSize: "3.2rem", margin: 0 }}
            >
              {genreName}
            </div>
          </div>
          <div style={{ color: "var(--text2)", fontSize: 14 }}>
            Filmes · Navega por popularidade, avaliação e muito mais
          </div>
        </div>
      </div>

      {/* ── Loading inicial ───────────────────────────────────────────────── */}
      {loading && (
        <div className="loader">
          <div className="spinner" />
        </div>
      )}

      {!loading && (
        <>
          {/* ── Top 10 do Mês ──────────────────────────────────────────────── */}
          {topMonth.length > 0 && (
            <TrendingCarousel
              items={topMonth}
              title="Top 10 do Mês"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          )}

          {/* ── Em Destaque ────────────────────────────────────────────────── */}
          {topSpotlight.length > 0 && (
            <TrendingCarousel
              items={topSpotlight}
              title="Em Destaque"
              onSelect={onSelect}
              ratingsMap={enrichedRatingsMap}
            />
          )}

          {/* ── Listagem completa com abas de ordenação ────────────────────── */}
          <div className="section">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 12,
                marginBottom: 16,
              }}
            >
              <div className="section-title" style={{ margin: 0 }}>
                Todos os Filmes&nbsp;
                <span style={{ color: "var(--red)" }}>{genreName}</span>
              </div>

              {/* Abas de ordenação */}
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  flexWrap: "wrap",
                }}
              >
                {SORT_OPTIONS.map((opt) => {
                  const isActive = sortId === opt.id;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => setSortId(opt.id)}
                      style={{
                        padding: "6px 14px",
                        background: isActive
                          ? "var(--red)"
                          : "var(--surface2)",
                        border: isActive
                          ? "1px solid var(--red)"
                          : "1px solid var(--border)",
                        borderRadius: 20,
                        color: isActive ? "#fff" : "var(--text2)",
                        cursor: "pointer",
                        fontSize: 12,
                        fontWeight: isActive ? 700 : 500,
                        fontFamily: "var(--font-body)",
                        transition: "all 0.15s",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Grid de cards */}
            {listLoading && listItems.length === 0 ? (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  padding: "40px 0",
                }}
              >
                <div className="spinner" />
              </div>
            ) : (
              <div className="cards-grid">
                {listItems.map((item) => {
                  const rk = `movie_${item.id}`;
                  const rd = enrichedRatingsMap[rk] || {};
                  return (
                    <MediaCard
                      key={`${item.id}-${sortId}`}
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
            )}

            {/* Sentinel para scroll infinito */}
            <div
              ref={sentinelRef}
              style={{
                height: 64,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginTop: 8,
              }}
            >
              {listLoading && listItems.length > 0 && (
                <div className="spinner" />
              )}
              {!listLoading && !hasMore && listItems.length > 0 && (
                <span
                  style={{
                    color: "var(--text3)",
                    fontSize: 13,
                    letterSpacing: "0.06em",
                  }}
                >
                  · Fim da lista ·
                </span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
