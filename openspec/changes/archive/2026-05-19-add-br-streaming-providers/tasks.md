## 1. Adicionar Pomfy ao PLAYER_SOURCES

- [x] 1.1 Abrir `src/utils/api.js` e localizar o array `PLAYER_SOURCES` (linha ~91)
- [x] 1.2 Inserir o objeto Pomfy após o entry de `2embed` e antes do `allmanga`:
  ```js
  {
    id: "pomfy",
    label: "Pomfy",
    tag: null,
    note: "PT-BR",
    supportsProgress: true,
    movieUrl: (id) => `https://api.pomfy.stream/filme/${id}`,
    tvUrl: (id, season, ep) => `https://api.pomfy.stream/serie/${id}/${season}/${ep}`,
  },
  ```
- [x] 1.3 Verificar que a ordem resultante é `[videasy, vidsrc, 2embed, pomfy, superflixapi, allmanga]`

## 2. Adicionar SuperflixAPI ao PLAYER_SOURCES

- [x] 2.1 Inserir o objeto SuperflixAPI após o entry de `pomfy` e antes do `allmanga`:
  ```js
  {
    id: "superflixapi",
    label: "SuperflixAPI",
    tag: "ANIME",
    note: "PT-BR",
    supportsProgress: true,
    movieUrl: (id) => `https://superflixapi.best/filme/${id}`,
    tvUrl: (id, season, ep) => `https://superflixapi.best/serie/${id}/${season}/${ep}`,
  },
  ```
- [x] 2.2 Confirmar que `ANIME_DEFAULT_SOURCE` permanece `"allmanga"` e `NON_ANIME_DEFAULT_SOURCE` permanece `"vidsrc"` — nenhuma alteração necessária

## 3. Verificar compatibilidade com lógica existente

- [x] 3.1 Confirmar que `getSourceUrl` em `api.js` (linha ~136) funciona sem alterações para os novos ids `"pomfy"` e `"superflixapi"`
- [x] 3.2 Confirmar que o auto-switch de anime em `MoviePage.jsx` (~linha 264) trata `superflixapi` corretamente: como provider com `tag` (não fará auto-switch para ele a partir de non-anime, e não sairá dele quando em anime)
- [x] 3.3 Confirmar que o auto-switch de anime em `TVPage.jsx` (~linha 603) tem o mesmo comportamento correto
- [x] 3.4 Confirmar que o dropdown de source em `MoviePage.jsx` (~linha 1005) renderiza os novos providers com seus badges `note` ("PT-BR") e `tag` ("ANIME") corretamente
- [x] 3.5 Confirmar que `storage.set("playerSource", src.id)` no clique do dropdown persiste corretamente os novos ids

## 4. Testar manualmente os novos providers

- [x] 4.1 Build de desenvolvimento (`npm run dev` ou equivalente) e abrir o app
- [ ] 4.2 Testar Pomfy em um filme: selecionar source "Pomfy", confirmar que o webview carrega `https://api.pomfy.stream/filme/{id}` e o player funciona
- [ ] 4.3 Testar Pomfy em uma série: navegar para um episódio, confirmar URL `https://api.pomfy.stream/serie/{id}/{season}/{ep}`
- [ ] 4.4 Testar SuperflixAPI em um filme: confirmar URL `https://superflixapi.best/filme/{id}`
- [ ] 4.5 Testar SuperflixAPI em uma série: confirmar URL `https://superflixapi.best/serie/{id}/{season}/{ep}`
- [ ] 4.6 Testar SuperflixAPI em um anime: confirmar que aparece no dropdown de anime e carrega corretamente
- [ ] 4.7 Verificar se algum provider usa Fullscreen API nativa (observar se o app entra em fullscreen ao clicar no botão de fullscreen do player); se sim, adicionar o `id` ao array `NEEDS_INTERCEPT` em `api.js` (~linha 152)
- [ ] 4.8 Verificar tracking de progresso: reproduzir um vídeo por ~30 segundos, pausar, navegar para outra página e voltar; confirmar que "Continue Watching" aparece na home. Se não aparecer, adicionar `progressViaFrames: true` ao descriptor do provider afetado

## 5. Verificar providers existentes não foram quebrados

- [x] 5.1 Confirmar que Videasy, VidSrc e 2Embed ainda carregam normalmente após as alterações
- [x] 5.2 Confirmar que AllManga ainda resolve e carrega anime corretamente
- [x] 5.3 Confirmar que o auto-switch entre anime/non-anime ainda funciona para os providers existentes
