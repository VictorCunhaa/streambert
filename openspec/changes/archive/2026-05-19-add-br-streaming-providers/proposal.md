## Why

O Streambert atualmente oferece apenas provedores de streaming com conteúdo predominantemente em inglês (VidSrc, Videasy, 2Embed), sem opções para o público brasileiro que consome conteúdo dublado em português. Adicionar Pomfy e SuperflixAPI expande significativamente o acesso a conteúdo em PT-BR, atendendo a uma audiência que não é servida pelos provedores atuais.

## What Changes

- Adicionar `pomfy` como novo provider de embed (filmes e séries, PT-BR, TMDB ID)
- Adicionar `superflixapi` como novo provider de embed (filmes, séries, animes, TMDB/IMDb ID, PT-BR)
- Ambos seguem o padrão de provider existente: entrada no array `PLAYER_SOURCES` com `movieUrl` e `tvUrl`
- Ambos são provedores síncronos (embed HTML direto, sem resolução assíncrona via IPC)
- `superflixapi` suporta anime — receberá `tag: "ANIME"` para aparecer como opção quando `isAnime === true`
- Nenhum dos providers exige autenticação ou variável de ambiente
- Nenhuma quebra de compatibilidade com providers existentes

## Capabilities

### New Capabilities

- `pomfy-provider`: Provider de embed PT-BR para filmes e séries via `api.pomfy.stream`, usando TMDB ID
- `superflixapi-provider`: Provider de embed PT-BR para filmes, séries e animes via `superflixapi.best`, usando TMDB ID

### Modified Capabilities

- `player-source-selection`: Atualização do comportamento de auto-switch de source para incluir `superflixapi` como opção anime PT-BR (além de `allmanga`)

## Impact

- **`src/utils/api.js`**: Adição de 2 entradas em `PLAYER_SOURCES`; possível ajuste em `ANIME_DEFAULT_SOURCE` / `NON_ANIME_DEFAULT_SOURCE`
- **`src/pages/MoviePage.jsx`** e **`src/pages/TVPage.jsx`**: Nenhuma mudança necessária — ambas as páginas iteram `PLAYER_SOURCES` dinamicamente
- **`NEEDS_INTERCEPT`**: Avaliar se algum dos novos providers usa Fullscreen API nativa (requer teste em webview)
- **Sem novas dependências npm**
- **Sem mudanças em IPC** — ambos são provedores síncronos
- **Sem mudanças em estrutura de dados** — `storage.get("playerSource")` persiste o `id` como string, compatível com qualquer novo `id`
