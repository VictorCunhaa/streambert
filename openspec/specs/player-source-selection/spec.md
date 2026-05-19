## MODIFIED Requirements

### Requirement: Seletor de source exibe todos os providers disponíveis
O sistema SHALL exibir no dropdown de source todos os providers presentes em `PLAYER_SOURCES`, incluindo Pomfy e SuperflixAPI, com seus respectivos `label`, `tag` e `note`.

#### Scenario: Dropdown exibe Pomfy com badge PT-BR
- **WHEN** o seletor de source é aberto
- **THEN** "Pomfy" SHALL aparecer com badge "PT-BR" e sem badge de categoria

#### Scenario: Dropdown exibe SuperflixAPI com badges ANIME e PT-BR
- **WHEN** o seletor de source é aberto
- **THEN** "SuperflixAPI" SHALL aparecer com badge "ANIME" e badge "PT-BR" simultaneamente

---

### Requirement: Auto-switch de source para anime inclui providers com tag ANIME
O sistema SHALL considerar qualquer provider com `tag: "ANIME"` (incluindo SuperflixAPI) como elegível para conteúdo anime, mas SHALL manter `allmanga` como `ANIME_DEFAULT_SOURCE`.

#### Scenario: Usuário com SuperflixAPI salvo vê SuperflixAPI em anime
- **WHEN** o usuário previamente selecionou SuperflixAPI e navega para um conteúdo anime
- **THEN** o sistema SHALL manter SuperflixAPI ativo (pois possui `tag: "ANIME"`) sem auto-switch

#### Scenario: Usuário com provider não-anime vê AllManga em anime
- **WHEN** o usuário previamente selecionou Videasy (sem tag) e navega para um conteúdo anime
- **THEN** o sistema SHALL fazer auto-switch para `ANIME_DEFAULT_SOURCE` (`allmanga`)

#### Scenario: Usuário com SuperflixAPI salvo vê conteúdo não-anime
- **WHEN** o usuário previamente selecionou SuperflixAPI e navega para um conteúdo não-anime (filme/série ocidental)
- **THEN** o sistema SHALL fazer auto-switch para `NON_ANIME_DEFAULT_SOURCE` (`vidsrc`), pois SuperflixAPI possui `tag` e não é elegível para não-anime
