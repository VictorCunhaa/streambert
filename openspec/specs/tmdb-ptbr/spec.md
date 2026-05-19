## ADDED Requirements

### Requirement: Chamadas TMDB com language=pt-BR
Todas as chamadas à TMDB API que retornam metadados de conteúdo (títulos, sinopses, elenco, géneros, detalhes) SHALL incluir o parâmetro `language=pt-BR`.

#### Scenario: Busca retorna títulos em pt-BR
- **WHEN** o usuário busca um título no SearchModal
- **THEN** a chamada `/search/multi` é feita com `language=pt-BR` e os resultados exibem títulos e sinopses em português quando disponíveis

#### Scenario: Página de detalhe exibe sinopse em pt-BR
- **WHEN** o usuário abre a página de um filme ou série
- **THEN** a sinopse, título e outros metadados são exibidos em português quando disponíveis no TMDB

#### Scenario: Fallback para inglês quando tradução indisponível
- **WHEN** o TMDB não possui tradução pt-BR para um título ou sinopse
- **THEN** o TMDB retorna automaticamente o conteúdo em inglês (comportamento nativo da API)

### Requirement: Listas trending/popular com region=BR
As chamadas de conteúdo em destaque (trending, popular, top rated) SHALL incluir o parâmetro `region=BR` para priorizar conteúdo relevante ao mercado brasileiro.

#### Scenario: Trending exibe conteúdo relevante ao Brasil
- **WHEN** a Home carrega as seções "Em Alta"
- **THEN** as chamadas de trending incluem `region=BR` além de `language=pt-BR`

#### Scenario: Busca livre não é afetada pelo region
- **WHEN** o usuário busca um título via SearchModal
- **THEN** a chamada de busca NÃO inclui `region=BR`, permitindo encontrar qualquer título independente de distribuição regional
