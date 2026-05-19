## 1. API TMDB — language=pt-BR e region=BR

- [x] 1.1 Em `src/utils/api.js`, modificar `tmdbFetch` para injetar automaticamente `language=pt-BR` em todas as chamadas de conteúdo
- [x] 1.2 Adicionar `region=BR` nas chamadas de trending, popular e top_rated em `src/utils/api.js` e `src/pages/HomePage.jsx`
- [x] 1.3 Garantir que a chamada `/search/multi` em `SearchModal.jsx` usa `language=pt-BR` mas NÃO usa `region=BR`

## 2. Componente SearchModal

- [x] 2.1 Traduzir placeholder: "Search movies and series..." ? "Buscar filmes e séries..."
- [x] 2.2 Traduzir mensagem offline: "?? No internet, search is unavailable offline." ? "?? Sem internet, a busca está indisponível offline."
- [x] 2.3 Traduzir estado vazio: 'No results for "{query}"' ? 'Nenhum resultado para "{query}"'
- [x] 2.4 Traduzir badge: "Series" ? "Série", "Movie" ? "Filme"
- [x] 2.5 Traduzir label: "Recent searches" ? "Buscas recentes"
- [x] 2.6 Traduzir botão: "Clear all" ? "Limpar tudo"
- [x] 2.7 Traduzir title: "Remove" ? "Remover"
- [x] 2.8 Traduzir hint: "Search for movies and series · ESC to close" ? "Buscar filmes e séries · ESC para fechar"

## 3. Componente SetupScreen

- [x] 3.1 Traduzir título: "STREAMBERT" (manter) e body text de instrução para pt-BR
- [x] 3.2 Traduzir placeholder: "Paste your TMDB Read Access Token (eyJ...)..." ? "Cole seu Token de Acesso de Leitura TMDB (eyJ...)..."
- [x] 3.3 Traduzir botão loading: "Checking…" ? "Verificando…"
- [x] 3.4 Traduzir botão: "Let's go" ? "Vamos lá"
- [x] 3.5 Traduzir botão: "Skip for now" ? "Pular por agora"
- [x] 3.6 Traduzir mensagens de erro (invalid token, access denied, timeout, unreachable, unexpected) para pt-BR

## 4. Componente Sidebar

- [x] 4.1 Traduzir tooltips: "Back (Ctrl+Z)" ? "Voltar (Ctrl+Z)", "Search (?F)" ? "Buscar (?F)"
- [x] 4.2 Traduzir tooltips: "Home" ? "Início", "Library & History" ? "Biblioteca e Histórico", "Downloads" ? "Downloads"
- [x] 4.3 Traduzir tooltips: "Help & Shortcuts (?)" ? "Ajuda e Atalhos (?)", "Settings" ? "Configurações", "Quit App" ? "Fechar App"
- [x] 4.4 Traduzir item de menu de contexto: "Remove" ? "Remover"

## 5. Página HomePage

- [x] 5.1 Traduzir heading offline: "No internet connection" ? "Sem conexão com a internet"
- [x] 5.2 Traduzir mensagem offline para pt-BR
- [x] 5.3 Traduzir botão: "Retry" ? "Tentar novamente"
- [x] 5.4 Traduzir badge: "Trending · Movie" ? "Em Alta · Filme"
- [x] 5.5 Traduzir botões: "Watch Now" ? "Assistir Agora", "More Info" ? "Mais Informações"
- [x] 5.6 Traduzir títulos de seção: "Continue Watching" ? "Continuar Assistindo", "Similar to" ? "Similar a", "Trending Movies" ? "Em Alta - Filmes", "Trending Series" ? "Em Alta - Séries", "Top Rated" ? "Mais Bem Avaliados"

## 6. Página LibraryPage

- [x] 6.1 Traduzir título: "My Library" ? "Minha Biblioteca"
- [x] 6.2 Traduzir subtítulo: "Watch history, progress, and saved titles" ? "Histórico, progresso e títulos salvos"
- [x] 6.3 Traduzir seções: "Continue Watching" ? "Continuar Assistindo", "Watch History" ? "Histórico"
- [x] 6.4 Traduzir badges: "Series" ? "Série", "Movie" ? "Filme"
- [x] 6.5 Traduzir estado vazio: "Nothing here yet" ? "Nada aqui ainda", corpo para pt-BR
- [x] 6.6 Atualizar `toLocaleDateString` de `"en-US"` para `"pt-BR"` na formatação de datas

## 7. Componentes Modais

- [x] 7.1 Traduzir `KeyboardShortcutsModal`: título "KEYBOARD SHORTCUTS" ? "ATALHOS DO TECLADO", descrições de atalhos, seção de ajuda/GitHub
- [x] 7.2 Traduzir `UpdateModal`: título "UPDATE AVAILABLE" ? "ATUALIZAÇÃO DISPONÍVEL", textos de progresso, botões e mensagens de erro

## 8. Página SettingsPage

- [x] 8.1 Traduzir título e subtítulo: "SETTINGS" ? "CONFIGURAÇÕES", "App configuration for Streambert" ? "Configuração do Streambert"
- [x] 8.2 Traduzir grupos de seção: "General", "Content", "Playback", "Interface", "Library & Privacy", "Backup & Restore", "Storage & Data" e seus subtítulos
- [x] 8.3 Traduzir seção "App Version": labels, botões de atualização e toggle de verificação automática
- [x] 8.4 Traduzir seção "Home Page Layout": descrições, opções de layout (Carousel/Grid), botão "Save Layout"
- [x] 8.5 Traduzir seção "Backup & Restore": descrições, botões export/import, opções de frequência
- [x] 8.6 Traduzir seção "Appearance": labels de cor, fonte, toggles compact/animations
- [x] 8.7 Traduzir seção "Library & Privacy": labels de ordenação, opções, toggle de histórico e aviso
- [x] 8.8 Traduzir seção "Start Page": descrição e opções de página inicial
- [x] 8.9 Traduzir seção "Subtitle Downloads": descrições, labels, badges, botões
- [x] 8.10 Traduzir seção "Desktop Notifications": descrições e toggles
- [x] 8.11 Traduzir seção "Age Rating & Parental Controls": descrição, labels
- [x] 8.12 Traduzir dialogs de confirmação: "RESET STREAMBERT?", "CLEAR WATCH PROGRESS?", "DELETE ALL DOWNLOADS?"
- [x] 8.13 Traduzir barra de busca interna das configurações: placeholder "Search on this page…" ? "Buscar nesta página…"
- [x] 8.14 Traduzir itens de navegação "Jump to Section" para pt-BR

