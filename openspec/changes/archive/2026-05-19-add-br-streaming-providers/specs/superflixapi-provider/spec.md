## ADDED Requirements

### Requirement: SuperflixAPI provider disponível no seletor de source
O sistema SHALL incluir o provider SuperflixAPI (`id: "superflixapi"`) no array `PLAYER_SOURCES` com label "SuperflixAPI", note "PT-BR", e `tag: "ANIME"`.

#### Scenario: SuperflixAPI aparece no dropdown de source para conteúdo geral
- **WHEN** o usuário abre o seletor de source em um filme ou série não-anime
- **THEN** "SuperflixAPI" SHALL aparecer listado com os badges "ANIME" e "PT-BR" visíveis

#### Scenario: SuperflixAPI aparece no dropdown de source para anime
- **WHEN** o usuário abre o seletor de source em conteúdo identificado como anime
- **THEN** "SuperflixAPI" SHALL aparecer listado e ser selecionável como opção de anime PT-BR

---

### Requirement: SuperflixAPI constrói URL de filme corretamente
O sistema SHALL construir a URL de embed de filme do SuperflixAPI usando o TMDB ID no formato `https://superflixapi.best/filme/{TMDB_ID}`.

#### Scenario: URL de filme com TMDB ID válido
- **WHEN** o usuário seleciona SuperflixAPI como source em um filme com TMDB ID `603`
- **THEN** o webview SHALL carregar `https://superflixapi.best/filme/603`

---

### Requirement: SuperflixAPI constrói URL de série e anime corretamente
O sistema SHALL construir a URL de embed de série/anime do SuperflixAPI no formato `https://superflixapi.best/serie/{TMDB_ID}/{season}/{episode}`.

#### Scenario: URL de série com temporada e episódio
- **WHEN** o usuário seleciona SuperflixAPI como source no episódio S01E01 da série com TMDB ID `66732`
- **THEN** o webview SHALL carregar `https://superflixapi.best/serie/66732/1/1`

#### Scenario: URL de anime com episódio de temporada virtual
- **WHEN** o usuário seleciona SuperflixAPI como source num anime com TMDB ID `31910`, S02E05
- **THEN** o webview SHALL carregar `https://superflixapi.best/serie/31910/2/5` (após aplicação de mapeamentos de episódio existentes)

---

### Requirement: SuperflixAPI carregado na session de player com ad-blocking
O sistema SHALL carregar o webview do SuperflixAPI na session `persist:player`.

#### Scenario: M3u8 intercept ativo para SuperflixAPI
- **WHEN** o SuperflixAPI resolve um stream HLS internamente
- **THEN** o handler `onBeforeRequest` SHALL interceptar a URL `.m3u8` e emitir `m3u8-found`

---

### Requirement: SuperflixAPI não altera o default source de anime
O sistema SHALL manter `allmanga` como `ANIME_DEFAULT_SOURCE`. SuperflixAPI é uma opção adicional, não o padrão.

#### Scenario: Auto-switch para anime preserva AllManga como padrão
- **WHEN** o conteúdo é identificado como anime e nenhuma preferência de source foi salva previamente
- **THEN** o sistema SHALL selecionar `allmanga` como source ativo, não `superflixapi`
