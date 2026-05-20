## Context

O Streambert é um app Electron que usa um `<webview>` para reproduzir conteúdo de fontes externas (SuperflixAPI, VidSrc, AllManga, 2Embed, Videasy, EmbedMovies, etc). O player roda no processo renderer; a comunicação com o processo main se dá via IPC (`ipcRenderer`/`ipcMain`). Hoje os controles do player ficam no `player-overlay-group` — um grupo de botões flutuantes acima do webview (Source, SUB/DUB, Shield, Pop-out). A proposta é adicionar um botão **Cast** nesse grupo, que permite enviar o vídeo atual a um dispositivo Chromecast ou DLNA na rede local.

O desafio central: o player é um `<webview>`, não um elemento `<video>` nativo. Não podemos usar a Web Cast API (que exige contexto de página web convencional). O cast precisa ser feito **no processo main do Electron**, que tem acesso a sockets de rede e pode implementar o protocolo Cast v2 (Chromecast) e/ou UPnP/DLNA diretamente.

O sistema existente de progresso assistido faz polling de `currentTime` do webview a cada 1–3 s via `executeJavaScript` ou `query-video-progress` IPC (para fontes com iframes aninhados cross-origin). O cast não pode quebrar esse fluxo.

## Goals / Non-Goals

**Goals:**
- Descobrir dispositivos Chromecast e DLNA na rede local via mDNS/SSDP
- Exibir lista de dispositivos num dropdown sobre o player (ambos MoviePage e TVPage)
- Enviar a URL de stream atual ao dispositivo selecionado e iniciar reprodução remota
- Refletir estado de conexão no botão: idle / conectando / transmitindo / erro
- Desconectar e retornar ao player local com um clique
- Controlar playback remotamente a partir do dropdown: pause/resume, seek para posição arbitrária e ajuste de volume
- Sincronizar progresso assistido (`streambert_progress`, `streambert_dlTime_*`) durante cast ativo — usando o `currentTime` reportado pelo dispositivo como fonte de verdade, mantendo compatibilidade total com o sistema de resume e auto-mark watched existente

**Non-Goals:**
- Suporte a AirPlay (protocolo diferente, requer macOS API)
- Casting de conteúdo DRM protegido (depende do dispositivo e fonte)
- Funcionar quando a URL da fonte requer autenticação de curto prazo (tokens expiram; documentar como limitação)
- Controles avançados de fila ou playlist no dispositivo

## Decisions

### D1 — Biblioteca: `castv2-client` (Chromecast) + `node-ssdp` (DLNA)

**Escolha:** `castv2-client` para Chromecast e `node-ssdp` para descoberta DLNA/UPnP.

**Alternativas consideradas:**
- `electron-chromecast` — desatualizado, sem manutenção ativa desde 2018.
- Web Cast API via `navigator.presentation` — não disponível em `<webview>` Electron.
- `go-chromecast` subprocess — complexidade de empacotamento desnecessária.

**Rationale:** `castv2-client` é a implementação Node.js mais madura do protocolo Cast v2. `node-ssdp` é leve e usado amplamente para descoberta UPnP. Ambos rodam no processo main do Electron, sem modificações ao webview.

### D2 — Arquitetura: IPC bridge no processo main

Criar `src/ipc/cast.js` (novo arquivo) com os handlers IPC:
- `cast:discover` → inicia scan mDNS + SSDP por 5 s, retorna lista de dispositivos
- `cast:connect` → conecta ao dispositivo selecionado, envia URL de stream
- `cast:disconnect` → encerra sessão de cast
- `cast:status` → retorna estado atual (idle/connecting/casting/error) + `{ currentTime, duration }` do dispositivo
- `cast:control` → envia comando de playback ao dispositivo (pause/resume/seek/volume)

O renderer (MoviePage/TVPage) chama `ipcRenderer.invoke('cast:*')` etc. via o bridge existente em `src/utils/ipc.js` (ou diretamente via `window.api` se já exposto).

**Alternativa:** lógica de cast toda no renderer via `ipcRenderer.sendSync` — rejeitado por bloquear a UI thread.

### D3 — URL de stream: capturar do webview via `did-navigate`

O webview dispara eventos de navegação acessíveis via `webviewRef.current.addEventListener('did-navigate', ...)`. A URL final de stream é capturada nesse evento e armazenada em estado React (`streamUrl`). Esse valor é passado ao IPC `cast:connect`.

**Limitação conhecida:** fontes que usam HLS com tokens de curta duração podem falhar no dispositivo Cast se o token expirar antes de o dispositivo iniciar a reprodução.

### D4 — UI: dropdown do botão Cast

Botão Cast renderizado como `<button className="player-overlay-btn">` dentro do `player-overlay-group`, seguindo o padrão exato do botão Pop-out (MoviePage linha ~1072, TVPage linha ~1789). Ao clicar, renderiza um dropdown absoluto com:
- Lista de dispositivos descobertos + botão re-scan
- Quando `castState === 'casting'`: controles de playback (pause/resume, slider de seek, slider de volume) e botão Desconectar

Sem biblioteca de dropdown externa — usar `useState` + `useEffect` para fechar ao clicar fora (padrão já adotado em outros menus do app).

**Alternativa considerada:** overlay de controles separado sobre o webview — rejeitado por aumentar a superfície de UI sem benefício; o dropdown já é o ponto de interação natural do cast.

### D5 — Controle remoto de playback: `cast:control`

Handler `cast:control` recebe `{ action: 'pause'|'resume'|'seek'|'volume', position?, level? }` e envia o comando ao dispositivo via o `MediaController` do `castv2-client` (Chromecast) ou via SOAP UPnP AVTransport (DLNA).

### D6 — Sincronização de progresso assistido durante cast

**Problema:** o loop de progresso existente (`setInterval` em `MoviePage`/`TVPage`) faz polling de `currentTime` diretamente no webview via `executeJavaScript` ou `query-video-progress` IPC. Durante cast ativo, o webview local ainda carrega a URL mas o usuário assiste no dispositivo remoto — o `currentTime` do webview local fica zerado ou estagnado, corrompendo o progresso salvo.

**Solução:** o processo main emite o evento `cast:time-update` via `webContents.send` sempre que recebe um `MEDIA_STATUS` do dispositivo (Chromecast notifica a cada ~1 s). O renderer registra `ipcRenderer.on('cast:time-update', ...)` e mantém uma ref `castCurrentTimeRef`. O loop de progresso existente é modificado minimamente: quando `castState === 'casting'`, substitui o `currentTime` do webview pelo valor de `castCurrentTimeRef.current`. **Nenhuma mudança no formato de dados do localStorage** — apenas a fonte do `currentTime` muda.

Para DLNA (sem push de status), polling de fallback a cada 5 s chama `cast:status` IPC que retorna `{ currentTime, duration }` via AVTransport GetPositionInfo.

**Compatibilidade garantida:**
- `progressKey` (`tv_<id>_s<N>e<N>` / `movie_<id>`) — inalterado
- `saveProgress(key, pct)` em `App.jsx` — inalterado
- `streambert_dlTime_*` — inalterado, escrito com `currentTime` do dispositivo
- Auto-mark watched (`watchedThreshold`) — inalterado; continua comparando `duration - currentTime`
- Resume on load (`seekVideoInFrames`) — inalterado; cast é encerrado antes de retomar no webview local
- Todas as fontes de stream (SuperflixAPI, VidSrc, AllManga, 2Embed, Videasy, EmbedMovies) — sem alteração

## Risks / Trade-offs

- **mDNS requer permissão de rede no SO** → Mitigação: no macOS o Electron já solicita permissão; no Windows o firewall pode bloquear — instruir o usuário a permitir.
- **URL de stream pode expirar** → Mitigação: documentar como limitação v1; v2 pode implementar refresh de URL.
- **Dispositivos DLNA variam muito em suporte de codec** → Mitigação: enviar a URL diretamente (sem transcodificação); se o dispositivo não suportar o codec, falha com mensagem de erro.
- **Progresso durante cast pode ficar impreciso (DLNA)** → Mitigação: polling de fallback de 5 s via `cast:status` retorna `currentTime` do dispositivo; para Chromecast o push de `MEDIA_STATUS` é mais preciso.
- **`castv2-client` sem tipagem TypeScript** → sem impacto (projeto usa JS puro).
- **Dois arquivos grandes a modificar** (MoviePage 1304 linhas, TVPage 2397 linhas) → Risco de conflitos futuros; mitigado mantendo a adição do botão Cast isolada num componente `<CastButton>` separado.
