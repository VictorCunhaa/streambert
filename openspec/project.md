# Streambert — Project Reference

> Documento de referência técnica do projeto. Usado como contexto base para propostas, designs e tarefas no fluxo OpenSpec.

---

## Visão Geral

**Streambert** (v2.4.0) é uma aplicação desktop cross-platform construída com Electron para streaming e download de filmes, séries e anime. Zero anúncios, zero rastreamento, totalmente privada. Agrega conteúdo de embeds de terceiros (VidSrc, Videasy, 2Embed) e um scraper de anime (AllAnime/AllManga). Metadados via TMDB (filmes/séries) e AniList (anime). Downloads gerenciados por binário externo (`vid-dl-cli-only`).

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| Runtime | Electron v40 (Chromium + Node.js) |
| UI Framework | React 18 (hooks, lazy, Suspense) |
| Build Tool | Vite 7 + `@vitejs/plugin-react` |
| Bundler/Minifier | Rollup (via Vite) + Terser |
| Packaging | electron-builder v26 |
| Estilos | CSS vanilla com CSS custom properties |
| Fontes | DM Sans (300/regular/500/600), Bebas Neue (WOFF2, bundled) |
| Node.js APIs | `child_process`, `fs`, `https`, `http`, `crypto`, `zlib`, `os`, `path` |
| Electron APIs | `BrowserWindow`, `ipcMain`/`contextBridge`, `session`, `safeStorage`, `webContents`, `Notification`, `shell`, `dialog`, `webFrame` |
| APIs externas | TMDB (REST), AniList (GraphQL), AllAnime/api.allanime.day (GraphQL), AniSkip v2, SubDL, Wyzie/subs.wyzie.ru, GitHub Releases API |

**Dependências npm em runtime:** apenas `react` e `react-dom`. Todo o resto é devDependency.

**Programas externos requeridos em runtime (não npm):**
- `vid-dl-cli-only` — binário de download (fornecido pelo usuário)
- `ffmpeg` / `ffprobe` — progresso de download e query de duração de vídeo
- `mpv` ou `VLC` — opcional, para abrir downloads em timestamps
- `yt-dlp` — opcional, para resolver streams de anime via YouTube

---

## Arquitetura

### Modelo de Processos Electron

```
Main Process (index.js)
├── BrowserWindow (app principal, carrega dist/index.html)
│   └── preload.js → expõe window.electron via contextBridge
├── BrowserWindow (pop-out PiP player, opcional)
│   └── popout-preload.js → injeta titlebar flutuante, expõe window.electronPopout
├── Session: persist:player  (ad-blocked, intercepta m3u8/vtt)
├── Session: persist:trailer (ad-blocked, cookie de consentimento YouTube)
├── Session: partition:wyzie-redeem (não-persistente, para resgate de chave Wyzie)
└── HTTP server (localhost, porta aleatória) → proxy do player de anime
```

O `index.js` importa seis módulos IPC, chama `register()` em cada um, e gerencia o ciclo de vida das janelas.

### Renderer Process

React 18 SPA, bootstrapado em `src/main.jsx`. O `App.jsx` contém todo o estado global e implementa um roteador single-level customizado (`page` state + função `navigate()`). Todas as seis páginas são lazy-loaded via `React.lazy()` + `<Suspense>`.

### Diagrama Geral

```
┌─────────────────────────────────────────────────────────┐
│                    Main Process (index.js)               │
│                                                         │
│  ┌─────────────┐  ┌────────────┐  ┌──────────────────┐ │
│  │ downloads.js│  │ allmanga.js│  │    player.js     │ │
│  │ storage.js  │  │subtitles.js│  │  blockStats.js   │ │
│  └─────────────┘  └────────────┘  └──────────────────┘ │
│                                                         │
│  Sessions: persist:player | persist:trailer | partition:wyzie │
│  HTTP Server (porta aleatória) → proxy do player anime  │
└───────────────┬────────────────────────┬────────────────┘
                │ contextBridge          │ IPC
                │ (preload.js)           │ (~60 funções)
┌───────────────▼────────────────────────▼────────────────┐
│                 Renderer Process (React SPA)             │
│                                                         │
│  App.jsx (todo o estado global)                         │
│    ├── HomePage  (lazy)                                 │
│    ├── MoviePage (lazy)  ← webview: persist:player      │
│    ├── TVPage    (lazy)  ← webview: persist:player      │
│    ├── LibraryPage (lazy)                               │
│    ├── DownloadsPage (lazy)                             │
│    └── SettingsPage (lazy)                              │
└─────────────────────────────────────────────────────────┘
```

---

## Estrutura de Pastas

```
streambert/
├── index.js              ← Electron main process entry point
├── index.html            ← HTML shell (apenas <div id="root">)
├── preload.js            ← contextBridge: expõe window.electron ao renderer
├── popout-preload.js     ← Injeta titlebar customizado na janela PiP/pop-out
├── vite.config.js        ← Vite: plugin React, manual chunks, Terser
├── package.json          ← scripts npm, config electron-builder
│
├── src/
│   ├── main.jsx          ← Entry React: ReactDOM.createRoot → <App/>
│   ├── App.jsx           ← Componente root, todo o estado global (~1266 linhas)
│   │
│   ├── pages/            ← Páginas lazy-loaded
│   │   ├── HomePage.jsx      ← Carrosséis trending, "Continue Watching", histórico
│   │   ├── MoviePage.jsx     ← Detalhe de filme, player embed, UI de download
│   │   ├── TVPage.jsx        ← Detalhe TV/anime, seletor de episódio, player
│   │   ├── LibraryPage.jsx   ← Watchlist + histórico
│   │   ├── DownloadsPage.jsx ← Fila de downloads, browser de arquivos locais
│   │   └── SettingsPage.jsx  ← Configurações (API keys, aparência, backup, etc.)
│   │
│   ├── components/       ← Componentes UI reutilizáveis
│   │   ├── Sidebar.jsx               ← Sidebar de navegação com drag-and-drop
│   │   ├── WindowTitlebar.jsx        ← Titlebar customizado (Windows/Linux)
│   │   ├── SearchModal.jsx           ← Overlay de busca full-text TMDB
│   │   ├── MediaCard.jsx             ← Card de poster reutilizável
│   │   ├── DownloadModal.jsx         ← Dialog de configuração de download
│   │   ├── SubtitleDownloaderModal.jsx ← Busca de legendas (SubDL/Wyzie)
│   │   ├── TrailerModal.jsx          ← Trailer YouTube em session separada
│   │   ├── TrendingCarousel.jsx      ← Carrossel horizontal de trending
│   │   ├── SetupScreen.jsx           ← Tela de primeiro uso (entrada de API key)
│   │   ├── UpdateModal.jsx           ← Downloader/instalador de atualizações
│   │   ├── CloseConfirmModal.jsx     ← Confirmação "downloads rodando, sair?"
│   │   ├── BlockedStatsModal.jsx     ← Popup de estatísticas de bloqueio
│   │   ├── WyzieKeyModal.jsx         ← Fluxo de resgate de chave Wyzie
│   │   ├── KeyboardShortcutsModal.jsx ← Referência de atalhos de teclado
│   │   ├── Icons.jsx                 ← Todos os ícones SVG como componentes React
│   │   └── ErrorBoundary.jsx         ← React error boundary
│   │
│   ├── ipc/              ← Módulos IPC do main process (CommonJS, Node.js)
│   │   ├── downloads.js  ← Fila de downloads, spawna binário, parseia progresso
│   │   ├── storage.js    ← safeStorage (keychain do OS), backups agendados
│   │   ├── subtitles.js  ← Busca SubDL/Wyzie, extração de ZIP, salva srt
│   │   ├── allmanga.js   ← Resolver AllAnime GraphQL + servidor HTTP player local
│   │   ├── player.js     ← Controles de janela, open-at-time, ffprobe, auto-updater
│   │   └── blockStats.js ← Contador de requisições bloqueadas + persistência em disco
│   │
│   ├── utils/            ← Utilitários do renderer (ES modules)
│   │   ├── api.js           ← Fetch TMDB (cached, rate-limited), AniList, fontes player
│   │   ├── storage.js       ← Wrapper localStorage, registro STORAGE_KEYS, ponte secureStorage
│   │   ├── appearance.js    ← Presets de cor de destaque + applyAccentColor()
│   │   ├── backup.js        ← Lista BACKUP_KEYS, collectBackupData(), restoreBackupData()
│   │   ├── updates.js       ← Checker de updates via GitHub Releases API, comparação semver
│   │   ├── aniSkip.js       ← AniSkip API (timings intro/outro, cache 7 dias)
│   │   ├── subtitles.js     ← Lista SUBTITLE_LANGUAGES, helpers de badge de fonte
│   │   ├── episodeMappings.js ← Mapeamentos de episode group TMDB (ex: La Casa de Papel)
│   │   ├── homeLayout.js    ← Ordem/visibilidade das linhas da home
│   │   ├── ageRating.js     ← Fetch de classificação etária TMDB + restrição parental
│   │   ├── useRatings.js    ← Hook React para fetch em lote de classificações + cache
│   │   └── useBlockedStats.js ← Hook React para eventos IPC de block-stats
│   │
│   └── styles/
│       ├── global.css          ← Todo o CSS (variáveis, layout, componentes, animações)
│       └── fonts/              ← Arquivos de fonte WOFF2 bundled
│
├── public/               ← Assets estáticos (logo.svg, icon.png, installer-sidebar.bmp)
├── openspec/             ← Configuração de tooling AI (opencode/openspec)
└── .github/
    └── workflows/
        ├── build.yml     ← Build macOS manual (GitHub Actions)
        └── codeql.yml    ← Scanning de segurança CodeQL
```

---

## Fluxo da Aplicação

### Primeiro Uso
1. `index.js` inicia → `createWindow()` → carrega `dist/index.html`
2. React monta → `App.jsx` chama `secureStorage.get("apikey")` via IPC
3. Se sem API key → `<SetupScreen>` → usuário digita token TMDB → salvo no keychain via `safeStorage`
4. Em lançamentos subsequentes, a chave é carregada do keychain e validada contra `api.themoviedb.org/3/configuration`

### Streaming (Filme/Série)
1. Usuário navega → `MoviePage`/`TVPage` faz fetch dos detalhes TMDB
2. Se anime (gênero 16 + japonês) → também faz fetch dos metadados AniList
3. Clica em "Play" → `<webview>` com session `persist:player` carrega a URL do embed
4. Handler `onBeforeRequest` no `index.js` intercepta URLs `.m3u8` → envia evento IPC `m3u8-found` ao renderer
5. Renderer escuta via `window.electron.onM3u8Found()` → armazena URL para download eventual
6. Tracking de progresso: `player.js` `query-video-progress` itera todos os iframes aninhados via `frame.executeJavaScript` para encontrar elementos `<video>`

### Anime (AllAnime)
1. Clique em "Play" → `TVPage` chama `window.electron.resolveAllManga({title, season, episode, translationType})`
2. `allmanga.js` no main process: busca GraphQL AllAnime → decodifica URLs criptografadas (AES-256-CTR, chave `Xot36i3lK3:v1`) → busca endpoint `clock.json` CDN → retorna URL `.mp4` direta
3. Servidor Node.js `http.createServer` inicia em porta aleatória → serve página HTML de player + endpoint de proxy transparente (para Referer correto)
4. IPC `set-player-video` armazena URL no estado do módulo → URL do player é `http://127.0.0.1:<port>/player`
5. URL carregada em `<webview>` dentro do app

### Download
1. URL m3u8 interceptada → usuário clica "Download" → `DownloadModal` abre
2. Usuário seleciona pasta de saída, legendas opcionais
3. `window.electron.runDownload({binaryPath, m3u8Url, ...})` invocado
4. `downloads.js` spawna binário `vid-dl-cli-only` com args `--cli`
5. Linhas de stdout/stderr parseadas com regex para progresso de fragmento, timings ffmpeg, destino do arquivo, erros
6. Atualizações de progresso enviadas via eventos IPC `download-progress` → UI atualiza reativamente
7. Na conclusão: arquivo renomeado para título limpo de mídia, arquivos de legenda opcionais baixados e colocados junto

### Legendas
1. `SubtitleDownloaderModal` chama `window.electron.searchSubtitles({tmdbId, language, ...})`
2. Main process tenta SubDL primeiro (se chave configurada), depois Wyzie
3. Resultados SubDL chegam como arquivos ZIP → `extractFirstSubtitleFromZip()` (parser ZIP manual via `zlib`) extrai SRT/VTT/ASS
4. Arquivos salvos em `os.tmpdir()` e servidos como URLs `file://`
5. Legendas podem ser bundled com downloads (salvas junto aos arquivos de vídeo)

---

## Gerenciamento de Estado

Sem biblioteca externa (sem Redux, Zustand, MobX, etc.). Todo estado em `App.jsx` com hooks React nativos:

| Estado | Armazenamento | TTL |
|--------|--------------|-----|
| API keys (TMDB/SubDL/Wyzie) | OS keychain via `safeStorage` | Permanente |
| Watchlist, histórico, progresso, watched | `localStorage` (prefixo `streambert_`) | Permanente |
| Fila de downloads | `downloads.json` em userData | Permanente |
| Block stats | `blockStats.json` em userData | Permanente |
| Cache TMDB | In-memory Map (max 80 entries) | 5 minutos |
| Cache AniList, AniSkip | `localStorage` | 7 dias |
| Trending | `localStorage` | 30 minutos |

O wrapper `localStorage` em `src/utils/storage.js` adiciona prefixo `streambert_` em todas as chaves para evitar colisões.

---

## IPC Architecture

O preload script (`preload.js`) é a única ponte entre renderer e main process, expondo `window.electron` via `contextBridge`. Impõe **context isolation** (`contextIsolation: true`, `nodeIntegration: false`).

A bridge expõe ~60 funções em categorias:

| Categoria | Exemplos |
|-----------|---------|
| Captura de mídia | `onM3u8Found`, `onSubtitleFound` |
| Downloads | `runDownload`, `getDownloads`, `deleteDownload`, `showInFolder`, `scanDirectory` |
| Player | `setPlayerVideo`, `resolveAllManga`, `openPipWindow`, `queryVideoProgress`, `openPathAtTime` |
| Storage seguro | `secureGet`, `secureSet` |
| Legendas | `searchSubtitles`, `getSubtitleUrl`, `downloadSubtitlesForFile` |
| Controles de janela | `windowMinimize`, `windowToggleMaximize`, `windowClose`, `getPlatform` |
| Sistema | `showNotification`, `openExternal`, `quitApp`, `pickFolder`, `fileExists` |
| Cache/Reset | `getCacheSize`, `clearAppCache`, `resetApp`, `clearWatchData` |
| Updates | `detectUpdateFormat`, `downloadAndInstallUpdate`, `cancelUpdate` |
| Backups | `getScheduledBackupSettings`, `setScheduledBackupSettings`, `performScheduledBackup` |
| Block stats | `getBlockStats`, `onBlockedUpdate` |
| Wyzie | `wyzieOpenRedeem`, `wyzieValidateKey` |

---

## Padrões e Convenções

### Organização de Código

- **IPC modules como singletons CommonJS**: cada `src/ipc/*.js` exporta uma função `register()` + estado como variáveis de módulo. Sem classes.
- **Utils como ES modules**: `src/utils/*.js` usa named exports, importados diretamente por componentes React.
- **Router como state machine**: string `page` + array `navStack` em `App.jsx`. Sem `react-router` ou History API. Back navigation = Ctrl+Z.
- **Módulos IPC registrados no main**: `index.js` faz `import` e chama `register()` de cada módulo — sem instâncias de classe.

### Performance

- **Lazy loading**: todas as 6 páginas usam `React.lazy()`. Carregadas apenas na primeira visita.
- **Manual chunk splitting** no Vite: `react`, `settings`, `movie`, `tv`, `downloads` são bundles separados.
- **Cache em múltiplos níveis**: in-memory Map → localStorage → disco.
- **Throttling de requests TMDB**: semáforo com max 4 fetches concorrentes em `api.js`.
- **Memory cap**: heap V8 limitado a 256MB via `--max-old-space-size=256`, `--expose-gc`. GC explícito acionado no evento `player-stopped`.
- **Debouncing**: IPC de block stats com debounce de 250ms, writes em disco com 3s; writes localStorage imediatos mas guardados por equality checks.

### React

- `useCallback`/`useMemo` usados extensivamente para prevenir re-renders, especialmente em torno de `downloads`, `savedList`, `inProgress`.
- **Refs para closures estáveis**: `pageRef`, `selectedRef`, `savedRef` evitam bugs de stale closure em event handlers e intervals.
- **Functional state updates** para todo estado derivado (downloads, progress, saved, watched, history).
- `useEffect` com cleanup functions: `cancelled = true` e guards `mounted = false` consistentemente.

### Segurança

- `contextIsolation: true`, `nodeIntegration: false` em todas as janelas.
- Popups bloqueados globalmente (`setWindowOpenHandler(() => ({ action: "deny" }))`).
- Headers `X-Frame-Options` e `CSP` removidos das sessions de player/trailer para permitir embeds.
- Resgate de chave Wyzie via janela **não-persistente** (`partition:`) — sem cookies/storage após fechar.
- Encryption via OS (`safeStorage`): DPAPI (Windows), libsecret (Linux), Keychain (macOS). Fallback para base64 quando encryption indisponível.
- Migration file escrito no exit de update AppImage, deletado imediatamente na próxima inicialização.

### Ad Blocking

- Array hardcoded `BLOCKED_HOSTS` (~50 domínios conhecidos de ads/trackers) aplicado via `session.webRequest.onBeforeRequest` nas sessions `persist:player` e `persist:trailer`.
- URLs de mídia (`.m3u8`, `.vtt`) são exceções mesmo que correspondam a hosts bloqueados.
- Cada request bloqueado é contado e reportado ao renderer.
- Imagens TMDB recebem override `cache-control: public, max-age=604800, immutable` (7 dias) na session padrão.

### Theming

- Cores de destaque são CSS custom properties (`--red`, `--red2`, `--red-dim`, `--red-glow`) setadas em `:root` via `applyAccentColor()`. Naming histórico (padrão era vermelho); todos os 6 presets sobrescrevem as mesmas variáveis.
- Compact mode e reduced animations são classes CSS no body (`compact-mode`, `no-anim`).
- Font size via `webFrame.setZoomFactor()` do Electron.
- Titlebar customizado exibido apenas em `win32` e `linux` (macOS usa `hiddenInset`; Windows/Linux usam `titleBarStyle: "hidden"` + componente React).

---

## Regras Importantes

### O que NUNCA fazer

1. **Não adicionar npm packages ao `dependencies`** — apenas `react` e `react-dom` pertencem lá. Tudo mais vai em `devDependencies`.
2. **Não usar `nodeIntegration: true`** em nenhuma janela — viola o modelo de segurança do Electron.
3. **Não armazenar API keys em `localStorage`** — sempre usar `safeStorage` via IPC.
4. **Não criar instâncias de classe nos módulos IPC** — padrão é módulo singleton com `register()`.
5. **Não importar módulos Node.js no renderer** — usar IPC/contextBridge.
6. **Não adicionar bibliotecas de estado** (Redux, Zustand, etc.) sem justificativa forte — estado em `App.jsx` com hooks React.
7. **Não mudar o padrão de prefixo `streambert_`** no localStorage sem migrar chaves existentes.

### O que SEMPRE fazer

1. **Registrar novos handlers IPC no preload.js** via `contextBridge.exposeInMainWorld`.
2. **Usar `STORAGE_KEYS` registry** (`src/utils/storage.js`) para novas chaves de localStorage.
3. **Adicionar chaves sensíveis a `BACKUP_KEYS`** (`src/utils/backup.js`) se precisarem de backup.
4. **Usar `useCallback`/`useMemo`** para funções e valores passados como props em componentes de lista.
5. **Implementar cleanup em `useEffect`** — guards `cancelled`/`mounted` para evitar state updates em componentes desmontados.
6. **Aplicar debounce em writes frequentes** ao disco ou IPC.
7. **Lazy-load novas páginas** com `React.lazy()` e incluir no manual chunk splitting do Vite.

### Convenções de Nomenclatura

| Contexto | Convenção |
|----------|-----------|
| Chaves localStorage | `SCREAMING_SNAKE_CASE` no `STORAGE_KEYS`, prefixo `streambert_` |
| Eventos IPC | `kebab-case` (ex: `m3u8-found`, `download-progress`) |
| Arquivos de componente | `PascalCase.jsx` |
| Arquivos de utilitário | `camelCase.js` |
| Arquivos IPC | `camelCase.js` |
| CSS classes | `kebab-case` |
| CSS custom properties | `--kebab-case` |

---

## Build Pipeline

```
npm run dist:win
  └── cross-env ELECTRON_DIST=1 vite build
        → Terser: remove console.*, debugger
        → Chunks: react / settings / movie / tv / downloads
        → Output: dist/
  └── electron-builder --win --publish never
        → NSIS installer (.exe)
        → ASAR (fontes excluídas do ASAR para acesso pelo renderer)

Linux:  .deb + .AppImage + .pacman
macOS:  .dmg (x64 + arm64) — build manual via GitHub Actions
```

### Sistema de Update

- Checa GitHub Releases API para o release estável mais recente, compara semver.
- Download do instalador com seguimento de redirecionamentos, por plataforma.
- Estratégias de instalação por plataforma:
  - `.exe` → spawn → exit 0
  - `.appimage` → shell script aguarda morte do PID então substitui binário
  - `.deb` → `pkexec dpkg -i` ou `gdebi`
  - `.pacman` → `pkexec pacman -U` ou `pamac-installer`

---

## Decisões de Design Notáveis

1. **Sem npm packages no main process** — tudo é Node.js puro. Sem axios, electron-store, better-sqlite3. Mantém a instalação enxuta.

2. **Proxy HTTP local para anime** — em vez de carregar o site de streaming num webview (CORS/Referer restrictions), o app roda um servidor HTTP Node.js local numa porta aleatória que faz proxy dos bytes de vídeo com headers corretos. Mais confiável e rápido.

3. **Decriptação AES-256-CTR embutida** — chave `Xot36i3lK3:v1` hardcoded para AllAnime (portado de `ani-cli`). Frágil, mas necessário dado as proteções Cloudflare do AllAnime.

4. **Wyzie key redemption via child window** — o app abre `https://sub.wyzie.io/redeem` num BrowserWindow filho, monitora eventos `will-navigate`/`did-navigate`, extrai a chave do query parameter da URL de redirect, fecha a janela, envia a chave de volta.

5. **Router sem react-router** — navegação implementada puramente em React state (`page` string + array `navStack`). Ctrl+Z para voltar.

6. **Mapeamento de episódios TMDB** — alguns shows (ex: La Casa de Papel) têm numeração diferente entre streaming e TMDB. O app faz fetch da API de episode groups do TMDB e constrói um lookup map para traduzir números de episódio.

7. **Log de download em tempdir** — cada download escreve um arquivo de log em `os.tmpdir()`. Sucesso deleta o log; falha mantém e armazena o path na entrada de download, permitindo à UI exibir detalhes do erro.

8. **Backup agendado na inicialização** — main process detecta se backup é necessário (startup/daily/weekly/monthly) e dispara evento IPC `scheduled-backup-requested`. Renderer coleta dados do backup (localStorage) e chama de volta. Mantém acesso ao filesystem no main process enquanto coleta de dados fica no renderer (que tem acesso ao localStorage).
