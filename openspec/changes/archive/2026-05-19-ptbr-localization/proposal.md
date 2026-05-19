## Why

O Streambert é usado por falantes de português brasileiro, mas toda a interface e a busca de títulos estão em inglês, criando fricção desnecessária. Traduzir a interface e configurar a API TMDB para retornar dados em pt-BR melhora significativamente a experiência do usuário sem dependências externas.

## What Changes

- Todos os textos hardcoded na UI são traduzidos para português brasileiro (pt-BR)
- O parâmetro `language=pt-BR` é adicionado a todas as chamadas TMDB que buscam títulos, descrições, sinopses e metadados
- A busca de filmes e séries (`/search/multi`) passa a retornar títulos e sinopses em pt-BR
- Datas são formatadas com locale `pt-BR`
- O parâmetro `region=BR` é adicionado às buscas de trending para priorizar conteúdo relevante ao mercado brasileiro

## Capabilities

### New Capabilities

- `ui-ptbr`: Textos da interface traduzidos para pt-BR em todos os componentes e páginas
- `tmdb-ptbr`: Chamadas TMDB configuradas com `language=pt-BR` e `region=BR` para retornar metadados localizados

### Modified Capabilities

<!-- Nenhuma spec existente com requisitos alterados -->

## Impact

- **Arquivos de componentes**: `SearchModal.jsx`, `SetupScreen.jsx`, `Sidebar.jsx`, `KeyboardShortcutsModal.jsx`, `UpdateModal.jsx`
- **Arquivos de páginas**: `HomePage.jsx`, `LibraryPage.jsx`, `SettingsPage.jsx`
- **Utilitários de API**: `src/utils/api.js` — adição de `language=pt-BR&region=BR` nas chamadas `tmdbFetch`
- **Sem novas dependências** — a solução usa apenas parâmetros já suportados pela TMDB API
- **Sem breaking changes** — alterações são retrocompatíveis; dados existentes no localStorage continuam funcionando
