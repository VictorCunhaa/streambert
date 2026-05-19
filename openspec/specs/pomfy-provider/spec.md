## ADDED Requirements

### Requirement: Pomfy provider disponível no seletor de source
O sistema SHALL incluir o provider Pomfy (`id: "pomfy"`) no array `PLAYER_SOURCES` em `src/utils/api.js`, com label "Pomfy", note "PT-BR", e sem tag de categoria.

#### Scenario: Pomfy aparece no dropdown de source
- **WHEN** o usuário abre o seletor de source em qualquer conteúdo (filme ou série)
- **THEN** "Pomfy" SHALL aparecer listado com o badge "PT-BR" visível

---

### Requirement: Pomfy constrói URL de filme corretamente
O sistema SHALL construir a URL de embed de filme do Pomfy usando o TMDB ID do conteúdo no formato `https://api.pomfy.stream/filme/{TMDB_ID}`.

#### Scenario: URL de filme com TMDB ID válido
- **WHEN** o usuário seleciona Pomfy como source em um filme com TMDB ID `550`
- **THEN** o webview SHALL carregar `https://api.pomfy.stream/filme/550`

---

### Requirement: Pomfy constrói URL de série corretamente
O sistema SHALL construir a URL de embed de série do Pomfy no formato `https://api.pomfy.stream/serie/{TMDB_ID}/{season}/{episode}`.

#### Scenario: URL de série com temporada e episódio
- **WHEN** o usuário seleciona Pomfy como source no episódio S02E03 da série com TMDB ID `1396`
- **THEN** o webview SHALL carregar `https://api.pomfy.stream/serie/1396/2/3`

---

### Requirement: Pomfy carregado na session de player com ad-blocking
O sistema SHALL carregar o webview do Pomfy na session `persist:player` (que inclui ad-blocking e interceptação de m3u8).

#### Scenario: M3u8 intercept ativo para Pomfy
- **WHEN** o Pomfy resolve um stream HLS internamente
- **THEN** o handler `onBeforeRequest` SHALL interceptar a URL `.m3u8` e emitir o evento `m3u8-found`, tornando o download disponível
