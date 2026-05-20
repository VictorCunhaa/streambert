## 1. Dependências e Setup

- [x] 1.1 Instalar `castv2-client` e `node-ssdp` via npm e adicionar ao `package.json`
- [x] 1.2 Verificar que as dependências são compatíveis com a versão do Electron usada no projeto

## 2. IPC Main — `src/ipc/cast.js`

- [x] 2.1 Criar `src/ipc/cast.js` com handler `cast:discover` — inicia scan mDNS (Chromecast via `castv2-client` browser) + SSDP (`node-ssdp`) por 5 s e retorna array de `{ id, name, type, host, port }`
- [x] 2.2 Implementar handler `cast:connect` — recebe `{ deviceId, streamUrl }`, conecta ao dispositivo via `castv2-client` (Chromecast) ou UPnP (DLNA), envia URL e retorna `{ ok, error? }`
- [x] 2.3 Implementar handler `cast:disconnect` — encerra sessão ativa e retorna confirmação
- [x] 2.4 Implementar handler `cast:status` — retorna estado atual `idle | connecting | casting | error` + `{ currentTime, duration }` do dispositivo (via AVTransport GetPositionInfo para DLNA)
- [x] 2.5 Implementar handler `cast:control` — recebe `{ action: 'pause'|'resume'|'seek'|'volume', position?, level? }` e envia o comando ao dispositivo via `MediaController` (Chromecast) ou SOAP UPnP AVTransport (DLNA)
- [x] 2.6 Emitir evento `cast:time-update` via `webContents.send` sempre que receber `MEDIA_STATUS` do dispositivo Chromecast (`{ currentTime, duration, playerState }`) — para o renderer atualizar progresso em tempo real
- [x] 2.7 Registrar todos os handlers de `cast.js` no processo main (importar e chamar em `main.js` ou onde os outros IPC handlers são registrados)

## 3. Componente `CastButton`

- [x] 3.1 Criar `src/components/CastButton.jsx` com props: `streamUrl` (string), `onCastChange` (callback opcional)
- [x] 3.2 Implementar estado interno: `castState` (`idle | connecting | casting | error`), `devices` (array), `dropdownOpen` (bool), `remoteCurrentTime` (number), `remoteDuration` (number), `remotePaused` (bool)
- [x] 3.3 Implementar `handleOpen`: chama `ipcRenderer.invoke('cast:discover')`, atualiza `devices`, abre dropdown
- [x] 3.4 Implementar `handleConnect(device)`: chama `cast:connect` com `{ deviceId: device.id, streamUrl }`, atualiza `castState`
- [x] 3.5 Implementar `handleDisconnect`: chama `cast:disconnect`, retorna `castState` a `idle`
- [x] 3.6 Implementar `handlePause` / `handleResume`: chama `cast:control` com `{ action: 'pause' }` ou `{ action: 'resume' }`
- [x] 3.7 Implementar `handleSeek(position)`: chama `cast:control` com `{ action: 'seek', position }` ao soltar o slider
- [x] 3.8 Implementar `handleVolume(level)`: chama `cast:control` com `{ action: 'volume', level }` ao arrastar o slider de volume
- [x] 3.9 Registrar listener `ipcRenderer.on('cast:time-update', ...)` em `useEffect` para atualizar `remoteCurrentTime`, `remoteDuration` e `remotePaused`; fazer cleanup no return do `useEffect`
- [x] 3.10 Implementar `useEffect` de cleanup: ao desmontar o componente, chamar `cast:disconnect` se `castState === 'casting'`
- [x] 3.11 Implementar fechamento do dropdown ao clicar fora (click-outside `useEffect` com `mousedown` listener)
- [x] 3.12 Renderizar botão com ícone Cast e classe `player-overlay-btn`, com variação visual por estado (idle / spinner / destaque)
- [x] 3.13 Renderizar dropdown — seção de dispositivos: lista, "Nenhum dispositivo encontrado", botão "Tentar novamente"
- [x] 3.14 Renderizar dropdown — seção de controles (visível apenas quando `castState === 'casting'`): botão pause/resume, slider de seek com tempo atual/total, slider de volume, botão "Desconectar"

## 4. Integração em `MoviePage.jsx`

- [x] 4.1 Capturar a URL de stream atual do webview via evento `did-navigate` e armazenar em estado React (`streamUrl`)
- [x] 4.2 Importar `CastButton` em `MoviePage.jsx`
- [x] 4.3 Adicionar `<CastButton streamUrl={streamUrl} onCastChange={setCastState} />` dentro do `player-overlay-group` (após o botão Pop-out, linha ~1072)

## 5. Integração em `TVPage.jsx`

- [x] 5.1 Capturar a URL de stream atual do webview via evento `did-navigate` e armazenar em estado React (`streamUrl`)
- [x] 5.2 Importar `CastButton` em `TVPage.jsx`
- [x] 5.3 Adicionar `<CastButton streamUrl={streamUrl} onCastChange={setCastState} />` dentro do `player-overlay-group` (linha ~1789)

## 6. Compatibilidade de progresso assistido

- [x] 6.1 Em `MoviePage.jsx`: adicionar ref `castCurrentTimeRef` e registrar listener `ipcRenderer.on('cast:time-update', ...)` que atualiza a ref com `currentTime` e `duration` do dispositivo; fazer cleanup no `useEffect`
- [x] 6.2 Em `MoviePage.jsx`: no loop de polling de progresso (`setInterval`), antes de usar o `currentTime` do webview, verificar se `castState === 'casting'` e substituir pelo valor de `castCurrentTimeRef.current` quando disponível
- [x] 6.3 Em `TVPage.jsx`: repetir 6.1 — adicionar `castCurrentTimeRef` e listener `cast:time-update`
- [x] 6.4 Em `TVPage.jsx`: repetir 6.2 — substituir `currentTime` do webview pelo do dispositivo quando em cast
- [x] 6.5 Para DLNA (sem push de `MEDIA_STATUS`): implementar polling de fallback de 5 s em `CastButton` que chama `cast:status` e atualiza `castCurrentTimeRef` via callback ou evento IPC

## 7. Estilos

- [x] 7.1 Verificar que `player-overlay-btn` já cobre o botão Cast visualmente; adicionar overrides de cor em CSS para os estados `connecting` e `casting`
- [x] 7.2 Estilizar o dropdown do Cast: posição absoluta acima do botão, seção de dispositivos, seção de controles (pause/resume, sliders de seek e volume, botão desconectar)

## 8. Testes Manuais

- [x] 8.1 Testar descoberta de dispositivos: com Chromecast na rede, confirmar que aparece na lista
- [x] 8.2 Testar descoberta sem dispositivos: confirmar mensagem "Nenhum dispositivo encontrado" e botão "Tentar novamente"
- [x] 8.3 Testar cast de filme (MoviePage): iniciar reprodução, clicar Cast, selecionar dispositivo, confirmar vídeo no TV
- [x] 8.4 Testar cast de episódio (TVPage): idem
- [x] 8.5 Testar pause/resume remoto: confirmar que o dispositivo para e retoma corretamente
- [x] 8.6 Testar seek remoto: arrastar slider, confirmar que o dispositivo salta para o ponto correto
- [x] 8.7 Testar ajuste de volume remoto: arrastar slider, confirmar que o volume muda no dispositivo
- [x] 8.8 Testar progresso durante cast: verificar em DevTools que `streambert_progress` e `streambert_dlTime_*` são atualizados com o tempo do dispositivo (não do webview)
- [x] 8.9 Testar auto-mark watched durante cast: assistir até perto do fim, confirmar que o item é marcado como assistido
- [x] 8.10 Testar resume após cast: encerrar cast, fechar e reabrir o player, confirmar que retoma da posição correta
- [x] 8.11 Testar desconexão: confirmar que botão retorna a idle e cast encerra
- [x] 8.12 Testar cleanup: iniciar cast, navegar para outra página, confirmar que sessão é encerrada automaticamente
