## ADDED Requirements

### Requirement: Interface em português brasileiro
Todos os textos hardcoded na interface do Streambert SHALL ser exibidos em português brasileiro (pt-BR), incluindo labels, botões, placeholders, mensagens de erro, estados vazios e tooltips.

#### Scenario: Busca com placeholder traduzido
- **WHEN** o usuário abre o modal de busca
- **THEN** o placeholder do campo de busca exibe "Buscar filmes e séries..."

#### Scenario: Mensagem de offline traduzida
- **WHEN** o usuário abre o modal de busca sem conexão à internet
- **THEN** a mensagem exibe "Sem internet, a busca está indisponível offline."

#### Scenario: Badge de tipo de mídia traduzido
- **WHEN** resultados de busca são exibidos
- **THEN** o badge exibe "Série" para séries e "Filme" para filmes

#### Scenario: Botões da Home traduzidos
- **WHEN** o usuário visualiza o banner principal da Home
- **THEN** os botões exibem "Assistir Agora" e "Mais Informações"

#### Scenario: Títulos de seção da Home traduzidos
- **WHEN** o usuário visualiza a Home
- **THEN** as seções exibem "Em Alta · Filme", "Continuar Assistindo", "Em Alta - Filmes", "Em Alta - Séries", "Mais Bem Avaliados"

#### Scenario: Página de biblioteca traduzida
- **WHEN** o usuário abre a página de biblioteca
- **THEN** o título exibe "Minha Biblioteca", a seção exibe "Continuar Assistindo", "Lista de Interesse" e "Histórico"

#### Scenario: Estado vazio traduzido
- **WHEN** o histórico de assistidos está vazio
- **THEN** a mensagem exibe "Nada aqui ainda" e "Comece a assistir um filme ou série e seu histórico aparecerá aqui."

#### Scenario: Configurações com título traduzido
- **WHEN** o usuário abre as configurações
- **THEN** o título da página exibe "CONFIGURAÇÕES" e o subtítulo "Configurações do Streambert"

#### Scenario: Formatação de data em pt-BR
- **WHEN** uma data é exibida no histórico de assistidos
- **THEN** a data é formatada no padrão pt-BR (ex: "15 de janeiro de 2025")

### Requirement: Tela de configuração inicial traduzida
A tela de setup do token TMDB SHALL exibir todos os seus textos em pt-BR.

#### Scenario: Instruções do token traduzidas
- **WHEN** o usuário vê a tela de configuração inicial
- **THEN** o texto instrucional exibe as instruções em português

#### Scenario: Erros de validação de token traduzidos
- **WHEN** o token TMDB é inválido ou a requisição falha
- **THEN** a mensagem de erro é exibida em português
