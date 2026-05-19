## Context

O Streambert é um app Electron + React sem nenhuma biblioteca de i18n. Todos os textos UI estão hardcoded em inglês nos componentes JSX. As chamadas à TMDB API não passam o parâmetro `language`, fazendo com que títulos, sinopses e metadados sejam retornados em inglês por padrão.

O objetivo é traduzir todos os textos para pt-BR e configurar a API TMDB para retornar conteúdo localizado, sem introduzir uma biblioteca de i18n (o escopo é uma única língua).

## Goals / Non-Goals

**Goals:**
- Traduzir todos os textos hardcoded da UI para pt-BR
- Adicionar `language=pt-BR` a todas as chamadas `tmdbFetch` que retornam metadados de conteúdo (títulos, sinopses, elenco, trending, detalhes)
- Adicionar `region=BR` às chamadas de trending/popular para priorizar conteúdo relevante ao Brasil
- Formatar datas com locale `pt-BR`

**Non-Goals:**
- Introduzir biblioteca de i18n ou suporte a múltiplos idiomas
- Traduzir conteúdo gerado pelo usuário (histórico, watchlist)
- Modificar a API AniList (já retorna dados em inglês por padrão; títulos em pt-BR dependem da disponibilidade no AniList e estão fora de escopo)

## Decisions

### Decisão 1: Inline hardcoded strings → substituição direta (sem biblioteca i18n)

**Escolha:** Substituir os strings diretamente nos componentes JSX, sem extrair para arquivos de tradução.

**Alternativa considerada:** Adotar `react-i18next` + arquivos JSON de locale.

**Rationale:** O app tem um único idioma alvo. Introduzir i18next adicionaria dependência e complexidade desnecessárias. A substituição direta é mais simples, mais rápida de implementar e mais fácil de manter para um projeto de uma pessoa.

---

### Decisão 2: Parâmetro `language=pt-BR` na `tmdbFetch` — por chamada vs. global

**Escolha:** Adicionar `language=pt-BR` como parâmetro padrão dentro da própria função `tmdbFetch` (em `src/utils/api.js`) via append automático a todas as URLs, exceto endpoints que não suportam o parâmetro (e.g., autenticação).

**Alternativa considerada:** Adicionar o parâmetro em cada call-site individualmente.

**Rationale:** Centralizar na `tmdbFetch` garante que nenhuma chamada seja esquecida e evita duplicação. O TMDB aceita `language` em todos os endpoints de conteúdo; endpoints de auth não são afetados pois usam um caminho diferente.

---

### Decisão 3: `region=BR` apenas em endpoints de trending/popular

**Escolha:** Aplicar `region=BR` apenas nas chamadas de `/trending/*` e `/movie/popular`, `/tv/popular`, `/movie/top_rated`, `/tv/top_rated`.

**Rationale:** O parâmetro `region` restringe resultados por país. Aplicá-lo à busca livre (`/search/multi`) quebraria a busca de títulos internacionais não distribuídos no Brasil. Portanto, `region=BR` é adicionado apenas onde faz sentido restringir geograficamente (listas curadas), não em pesquisas livres.

## Risks / Trade-offs

- **[Risco] Cache existente retorna dados em inglês** → Mitigação: A `tmdbFetch` usa cache in-memory por sessão (TTL 5 min). Ao reiniciar o app, o cache é limpo e todas as chamadas passarão a usar `language=pt-BR`. Não há cache persistente de metadados.

- **[Risco] Títulos/sinopses sem tradução pt-BR no TMDB** → TMDB faz fallback automático para inglês quando não há tradução disponível. O comportamento é previsível e aceitável.

- **[Risco] Regressão em chamadas de API** → Mitigação: A mudança é adição de parâmetros de query, que o TMDB ignora caso não suporte. Não altera a estrutura da resposta.

## Migration Plan

1. Atualizar `src/utils/api.js`: injetar `language=pt-BR` em todas as chamadas de conteúdo dentro de `tmdbFetch`; adicionar `region=BR` onde aplicável
2. Traduzir componentes na ordem: `SearchModal` → `SetupScreen` → `Sidebar` → `KeyboardShortcutsModal` → `UpdateModal`
3. Traduzir páginas na ordem: `HomePage` → `LibraryPage` → `SettingsPage`
4. Atualizar formatações de data para `pt-BR`
5. Testar manualmente: busca de títulos, sinopses, trending, configurações

**Rollback:** Reverter commits individuais por arquivo; não há mudanças de schema ou banco de dados.
