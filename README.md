# Moodle Unisinos para o Claude

<img src="assets/icon.png" alt="" width="96" align="right">

Servidor [MCP](https://modelcontextprotocol.io) que conecta o **Claude** ao **Moodle da Unisinos** com a sua própria conta. Pergunte em português e o Claude consulta (e, com a sua confirmação, age) no Moodle por você.

> **Projeto independente**, feito por um aluno, sem vínculo oficial com a Unisinos. Usa a mesma API que o app oficial do Moodle usa no celular.

## O que dá para pedir

- *"O que vence esta semana?"* — prazos de tarefas e questionários, inclusive atrasados
- *"Como estão minhas notas?"* — boletim de cada disciplina, com comentários dos professores
- *"Resuma os slides da última aula de Engenharia de Software"* — lê PDFs, PPTX, DOCX, planilhas e páginas
- *"Baixe todos os PDFs de Álgebra"* — salva em `Downloads/Moodle Unisinos/<disciplina>`
- *"Já entreguei o trabalho de Algoritmos?"* / *"Entrega o arquivo C:\...\trabalho.pdf na Etapa 3"*
- *"Tem aviso novo dos professores?"* — fóruns, notificações e mensagens
- *"Abre o Exercício 2 de Álgebra"* — mostra as questões e marca **só a resposta que você disser**

## Instalação

Você precisa do [Claude Desktop](https://claude.ai/download) e do **Microsoft Edge** ou do **Google Chrome**, que são usados no login.

### Claude Desktop (recomendado, sem terminal)

1. Baixe o arquivo **`unisinos-moodle-mcp-<versão>.mcpb`** na [página de releases](https://github.com/renanhrt/unisinos-moodle-mcp/releases/latest).
2. Dê dois cliques no arquivo (ou arraste para a janela do Claude Desktop) e clique em **Instalar**.
3. Num chat novo, diga: **"conecta no meu Moodle"**.

### Claude Code

```bash
claude mcp add --scope user unisinos-moodle -- npx -y unisinos-moodle-mcp
```

<details>
<summary>Instalar a partir do código-fonte</summary>

```bash
git clone https://github.com/renanhrt/unisinos-moodle-mcp.git
cd unisinos-moodle-mcp
npm install
npm run build
claude mcp add --scope user unisinos-moodle -- node "$(pwd)/dist/index.js"
```

Para o Claude Desktop sem a extensão, acrescente ao `claude_desktop_config.json` (**Configurações → Desenvolvedor → Editar configuração**):

```json
{
  "mcpServers": {
    "unisinos-moodle": { "command": "node", "args": ["C:\\caminho\\para\\unisinos-moodle-mcp\\dist\\index.js"] }
  }
}
```
</details>

## Primeiro uso: login

Diga **"conecta no meu Moodle"**. Vai abrir uma janela do navegador no login da Microsoft da Unisinos. Entre com a sua conta institucional e confirme o MFA, se ele for pedido. A janela fecha sozinha ao terminar.

- O acesso fica salvo **só no seu computador**, em `~/.unisinos-moodle-mcp/`. Ele não passa por nenhum servidor além do próprio Moodle.
- Sua senha nunca passa pelo MCP. O login é feito na página da Microsoft, e o Moodle devolve um token, como acontece no app oficial.
- Quando o acesso expirar, o Claude avisa e pede o login de novo.
- Para sair, diga **"desconecta do Moodle"**. Em computador compartilhado, peça para também esquecer a conta da Microsoft.

## Segurança

Tudo que **altera** o Moodle funciona em duas etapas: o Claude mostra uma **prévia** e só executa depois que você confirmar.

| Ação | Prévia mostra |
|---|---|
| Entregar / remover envio de tarefa | arquivos novos, mantidos e substituídos; prazo; se é a entrega final; atraso; envio em grupo; tarefa já avaliada |
| Responder / criar / apagar no fórum | a mensagem respondida e o texto que será publicado |
| Enviar mensagem | destinatário e texto |
| Abrir / enviar questionário | tentativas usadas; questões sem resposta |

- O código de confirmação vale 15 minutos e uma única vez, só para aquela ação. Se qualquer detalhe mudar, ele é recusado.
- **Questionários:** a IA não sugere, não resolve e não escolhe respostas. Ela só mostra as questões e marca o que você disser. Se o pedido for ambíguo ("marca a 1" quando há uma opção com texto "1"), ela pergunta a letra.
- Downloads só são aceitos do próprio Moodle, para o token nunca ser enviado a outro site.
- Arquivos em pastas ocultas (como `.ssh`) e os dados internos do MCP não podem ser enviados como entrega.

## Ferramentas

| Área | Ferramentas |
|---|---|
| Conta | `moodle_login`, `moodle_logout`, `moodle_get_me` |
| Disciplinas | `moodle_list_courses`, `moodle_get_course_contents` |
| Prazos e notas | `moodle_upcoming_deadlines`, `moodle_get_grades`, `moodle_grades_overview`, `moodle_list_notifications` |
| Arquivos | `moodle_read_file` (PDF, PPTX, DOCX, XLSX, HTML, texto, imagens), `moodle_download_file` |
| Tarefas | `moodle_list_assignments`, `moodle_get_assignment_status`, `moodle_submit_assignment`, `moodle_remove_submission` |
| Fóruns | `moodle_list_forums`, `moodle_list_discussions`, `moodle_read_discussion`, `moodle_reply_forum`, `moodle_create_discussion`, `moodle_delete_forum_post` |
| Mensagens | `moodle_list_conversations`, `moodle_read_conversation`, `moodle_search_people`, `moodle_send_message` |
| Questionários | `moodle_list_quizzes`, `moodle_quiz_start`, `moodle_quiz_questions`, `moodle_quiz_answer`, `moodle_quiz_next_page`, `moodle_quiz_finish`, `moodle_quiz_review` |

## Problemas comuns

- **A janela de login não abre:** confira se o Edge ou o Chrome está instalado. Para escolher qual usar, defina `MOODLE_BROWSER_CHANNEL=chrome` ou `msedge`.
- **"O acesso ao Moodle expirou":** diga "conecta no meu Moodle" de novo.
- **Questionário com senha ou "navegador seguro":** essas regras exigem o navegador. Responda pelo Moodle.
- **Fórum de Avisos:** alunos não podem postar nele. A ferramenta avisa e não envia nada.

## Configuração (opcional)

| Variável | Padrão | Para quê |
|---|---|---|
| `MOODLE_DOWNLOAD_DIR` | `~/Downloads/Moodle Unisinos` | onde salvar os arquivos baixados |
| `MOODLE_BROWSER_CHANNEL` | Edge, depois Chrome | navegador do login |
| `UNISINOS_MOODLE_HOME` | `~/.unisinos-moodle-mcp` | onde guardar o acesso |
| `MOODLE_URL` | `https://www.moodle.unisinos.br` | outro Moodle com o app móvel habilitado (pode funcionar, mas não foi testado) |

## Desenvolvimento

```bash
npm install
npm test            # testes com um Moodle simulado
npm run dev         # servidor MCP direto do TypeScript
npm run pack:mcpb   # gera releases/unisinos-moodle-mcp-<versão>.mcpb
```

O servidor usa a API REST de Web Services do Moodle com o serviço `moodle_mobile_app`, o mesmo do app oficial. O login usa o fluxo do app (`admin/tool/mobile/launch.php`) num navegador controlado pelo [Playwright](https://playwright.dev), e o token só é aceito se a assinatura enviada pelo Moodle conferir.

Código em TypeScript, com o [SDK oficial de MCP](https://github.com/modelcontextprotocol/typescript-sdk).

## Licença

[MIT](LICENSE)
