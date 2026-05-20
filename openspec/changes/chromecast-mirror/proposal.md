## Why

Usuários assistem conteúdo no computador mas querem exibir o vídeo em uma TV ou projetor via Chromecast. Hoje não existe nenhuma forma de espelhar o player do Streambert para um dispositivo de cast sem sair do app.

## What Changes

- Adicionar um botão **"Cast"** no `player-overlay-group` de `MoviePage.jsx` e `TVPage.jsx` — aparece junto com os controles de Source, SUB/DUB, Shield e Pop-out quando o player está ativo.
- Ao clicar, abre um painel/dropdown listando os dispositivos Chromecast/DLNA descobertos na rede local via mDNS.
- Selecionar um dispositivo inicia o espelhamento: o vídeo atual (URL da fonte ativa no `webview`) é enviado ao dispositivo via Cast/DLNA.
- Botão reflete estado de conexão (idle → conectando → transmitindo → erro).
- Desconectar encerra o cast e retorna ao player local.

## Capabilities

### New Capabilities
- `chromecast-mirror`: Descoberta de dispositivos Cast/DLNA na rede local e controle de sessão de espelhamento a partir do player do Streambert.

### Modified Capabilities

## Impact

- `src/pages/MoviePage.jsx` — adicionar botão Cast no `player-overlay-group` (linha ~1022)
- `src/pages/TVPage.jsx` — idem (linha ~1789)
- `src/ipc/player.js` (ou novo `src/ipc/cast.js`) — handlers IPC para descoberta de dispositivos e controle de sessão Cast
- `package.json` — nova dependência: `castv2` ou `node-dlna` (TBD no design)
- Nenhuma mudança em localStorage ou schema de dados existente
