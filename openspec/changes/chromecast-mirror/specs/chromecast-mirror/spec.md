## ADDED Requirements

### Requirement: Botão Cast no player overlay
O sistema SHALL exibir um botão "Cast" dentro do `player-overlay-group` em `MoviePage` e `TVPage`, visível apenas quando o player está ativo (após o usuário iniciar a reprodução).

#### Scenario: Botão aparece quando o player está ativo
- **WHEN** o usuário inicia a reprodução de um filme ou episódio
- **THEN** o botão Cast aparece no `player-overlay-group` junto aos outros controles (Source, Shield, Pop-out)

#### Scenario: Botão não aparece antes de iniciar reprodução
- **WHEN** o usuário está na tela de detalhes mas ainda não pressionou Play
- **THEN** o botão Cast não é exibido

### Requirement: Descoberta de dispositivos Cast/DLNA
O sistema SHALL descobrir dispositivos Chromecast e DLNA na rede local ao clicar no botão Cast, via mDNS (Chromecast) e SSDP (DLNA), com timeout de 5 segundos.

#### Scenario: Dropdown abre com lista de dispositivos
- **WHEN** o usuário clica no botão Cast
- **THEN** um dropdown é exibido acima do botão com a lista de dispositivos encontrados na rede local

#### Scenario: Nenhum dispositivo encontrado
- **WHEN** o scan de 5 segundos não encontra nenhum dispositivo
- **THEN** o dropdown exibe a mensagem "Nenhum dispositivo encontrado" e um botão "Tentar novamente"

#### Scenario: Re-scan de dispositivos
- **WHEN** o usuário clica em "Tentar novamente" no dropdown
- **THEN** o sistema inicia um novo scan de 5 segundos e atualiza a lista

### Requirement: Iniciar sessão de cast
O sistema SHALL enviar a URL de stream atual ao dispositivo selecionado e iniciar a reprodução remota ao clicar num dispositivo da lista.

#### Scenario: Cast iniciado com sucesso
- **WHEN** o usuário seleciona um dispositivo da lista
- **THEN** o sistema conecta ao dispositivo, envia a URL de stream e o botão Cast indica estado "Transmitindo"

#### Scenario: Falha na conexão
- **WHEN** a conexão com o dispositivo falha (timeout ou erro de rede)
- **THEN** o botão Cast retorna ao estado idle e exibe uma mensagem de erro no dropdown

### Requirement: Estado visual do botão Cast
O botão Cast SHALL refletir o estado atual da sessão de cast com ícones e cores distintas.

#### Scenario: Estado idle
- **WHEN** não há sessão de cast ativa
- **THEN** o botão exibe ícone de cast na cor padrão (sem destaque)

#### Scenario: Estado conectando
- **WHEN** o sistema está estabelecendo conexão com um dispositivo
- **THEN** o botão exibe um indicador de loading/spinner

#### Scenario: Estado transmitindo
- **WHEN** há uma sessão de cast ativa
- **THEN** o botão exibe ícone de cast na cor de destaque (accent/branco brilhante)

### Requirement: Controle remoto de playback durante cast
O sistema SHALL permitir pausar, retomar e alterar a posição e volume da reprodução no dispositivo remoto a partir do dropdown do botão Cast, sem encerrar a sessão.

#### Scenario: Pausar reprodução remota
- **WHEN** o usuário clica em "Pausar" no dropdown durante uma sessão de cast ativa
- **THEN** o sistema envia o comando pause ao dispositivo e o botão de pause muda para "Retomar"

#### Scenario: Retomar reprodução remota
- **WHEN** o usuário clica em "Retomar" no dropdown enquanto o cast está pausado
- **THEN** o sistema envia o comando resume ao dispositivo e a reprodução continua do ponto em que estava

#### Scenario: Seek para posição arbitrária
- **WHEN** o usuário arrasta o slider de seek no dropdown para uma posição diferente e solta
- **THEN** o sistema envia o comando seek com a nova posição ao dispositivo e a reprodução retoma a partir desse ponto

#### Scenario: Ajuste de volume
- **WHEN** o usuário arrasta o slider de volume no dropdown
- **THEN** o sistema envia o comando volume ao dispositivo e o volume é ajustado em tempo real

#### Scenario: Controles visíveis apenas durante cast ativo
- **WHEN** o dropdown está aberto mas não há sessão de cast ativa
- **THEN** os controles de pause/resume/seek/volume não são exibidos

### Requirement: Sincronização de progresso assistido durante cast
O sistema SHALL continuar salvando o progresso assistido em `streambert_progress` e `streambert_dlTime_*` durante uma sessão de cast ativa, usando o `currentTime` reportado pelo dispositivo remoto como fonte de verdade — garantindo que o resume position e o auto-mark watched funcionem corretamente após encerrar o cast.

#### Scenario: Progresso salvo com tempo do dispositivo durante cast
- **WHEN** há uma sessão de cast ativa e o dispositivo reporta `currentTime`
- **THEN** o sistema salva o progresso usando o `currentTime` do dispositivo (não do webview local) em `streambert_progress` e `streambert_dlTime_*`, no mesmo formato e frequência de antes

#### Scenario: Auto-mark watched funciona durante cast
- **WHEN** o `currentTime` do dispositivo indica que o tempo restante é menor ou igual ao `watchedThreshold` configurado
- **THEN** o item é automaticamente marcado como assistido em `streambert_watched`, identicamente ao comportamento sem cast

#### Scenario: Resume position correto após encerrar cast
- **WHEN** o usuário encerra o cast e inicia a reprodução local do mesmo item
- **THEN** o player retoma a partir da posição salva durante o cast (última posição conhecida do dispositivo)

#### Scenario: Progresso não é corrompido pelo webview local durante cast
- **WHEN** há uma sessão de cast ativa e o webview local retorna `currentTime` zerado ou inválido
- **THEN** o sistema ignora o valor do webview e usa apenas o tempo reportado pelo dispositivo Cast

### Requirement: Encerrar sessão de cast
O sistema SHALL permitir desconectar o cast e retornar ao player local.

#### Scenario: Desconectar via botão no dropdown
- **WHEN** o usuário clica em "Desconectar" no dropdown durante uma sessão ativa
- **THEN** a sessão de cast é encerrada e o botão retorna ao estado idle

#### Scenario: Desconexão automática ao fechar o player
- **WHEN** o usuário fecha o player (navega para outra página ou clica em voltar)
- **THEN** qualquer sessão de cast ativa é encerrada automaticamente
