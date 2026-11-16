# unisinos-moodle-mcp

Servidor MCP (Model Context Protocol) para o Moodle da Unisinos: permite que um assistente de IA (Claude Desktop, Claude Code etc.) consulte e opere o portal em nome do aluno.

## Ideia central

O Moodle já tem uma **API oficial de Web Services** (`/webservice/rest/server.php`), usada pelo app **Moodle Mobile**. Se a Unisinos tem o app mobile habilitado, a gente reutiliza o mesmo serviço (`moodle_mobile_app`) com o token do próprio aluno. Isso dá acesso estável, rápido e dentro das permissões do aluno, sem precisar raspar HTML.

```
Claude ──(MCP / stdio)──> unisinos-moodle-mcp ──(REST + wstoken)──> Moodle Unisinos
                                │
                                └─ fallback: Playwright (só para o que a API não cobre)
```

## Autenticação

### O que o Moodle da Unisinos expõe (verificado em 2026-11-16)

Consulta pública `tool_mobile_get_public_config` em `https://www.moodle.unisinos.br/lib/ajax/service-nologin.php`:

| Campo | Valor | Significado |
|---|---|---|
| `enablewebservices` | `1` | API REST ligada |
| `enablemobilewebservice` | `1` | serviço `moodle_mobile_app` disponível para alunos |
| `typeoflogin` | `3` | login por navegador embutido (SSO) |
| `identityproviders` | Office365 via `auth/saml2` | login é Microsoft (SAML2) |
| `launchurl` | `/admin/tool/mobile/launch.php` | fluxo do app mobile para obter token |

`/login/index.php` redireciona direto para `login.microsoftonline.com`. Ou seja: **`/login/token.php` com usuário e senha não deve funcionar**. O caminho é o fluxo SSO do app.

### Fluxo escolhido: SSO do app mobile

1. Script `npm run login` abre um navegador visível (Playwright) em
   `https://www.moodle.unisinos.br/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=<aleatório>&urlscheme=moodlemobile`
2. O aluno faz login normalmente na Microsoft (incluindo MFA).
3. O Moodle redireciona para `moodlemobile://token=<base64>`. O script intercepta esse redirect.
4. O base64 decodifica para `assinatura:::token[:::privatetoken]`. A assinatura deve ser igual a `md5(wwwroot + passport)`; se não bater, descarta.
5. O token é salvo localmente (fora do git) e usado em `/webservice/rest/server.php?wstoken=...&moodlewsrestformat=json`.

O token do app costuma durar bastante (até o aluno sair ou o admin revogar). Quando expirar, basta rodar `npm run login` de novo.

**Fallback**: se o redirect for bloqueado, usar a sessão do navegador do Playwright (cookies) para o que for preciso.

O token fica em `.env` / cofre local e **nunca** vai para o git.

> Aviso de manutenção publicado pelo Moodle: indisponível em 31/12, 0h01–23h59.

## Ferramentas MCP planejadas

| Área | Ferramenta | Função do Moodle WS |
|---|---|---|
| Perfil | `get_me` | `core_webservice_get_site_info` |
| Disciplinas | `list_courses` | `core_enrol_get_users_courses` |
| Conteúdo | `get_course_contents`, `download_file` | `core_course_get_contents` + `/webservice/pluginfile.php` |
| Agenda | `upcoming_deadlines` | `core_calendar_get_action_events_by_timesort` |
| Tarefas | `list_assignments`, `get_submission_status` | `mod_assign_get_assignments`, `mod_assign_get_submission_status` |
| Entrega | `submit_assignment` (com confirmação) | `core_files_upload` + `mod_assign_save_submission` + `mod_assign_submit_for_grading` |
| Notas | `get_grades` | `gradereport_user_get_grade_items` |
| Fóruns | `list_discussions`, `read_discussion`, `reply_forum` | `mod_forum_*` |
| Mensagens | `list_conversations`, `send_message` | `core_message_*` |
| Notificações | `list_notifications` | `message_popup_get_popup_notifications` |
| Progresso | `mark_activity_done` | `core_completion_update_activity_completion_status_manually` |
| Novidades | `whats_new_since` | `core_course_get_updates_since` |

Além das ferramentas, **resources** MCP (ex.: `moodle://course/{id}`) e **prompts** prontos ("resumo da semana", "o que vence nos próximos 7 dias", "resuma o material da aula X").

## Regras de segurança

- Ações que escrevem (entregar tarefa, postar em fórum, enviar mensagem) exigem confirmação explícita.
- Questionários/provas: só leitura de informações (datas, tentativas). Nada de responder automaticamente; isso fere a integridade acadêmica.
- Respeitar limites de requisição e os termos de uso da Unisinos.

## Stack sugerida

- TypeScript + `@modelcontextprotocol/sdk`, transporte stdio
- `zod` para os schemas das ferramentas
- Playwright apenas como fallback

## Roadmap

1. ~~**Descoberta**: identificar a URL do Moodle e o tipo de login~~ ✅ SSO Office365, mobile WS habilitado.
2. **Login**: script Playwright que captura o token do app.
3. **MVP somente leitura**: `get_me`, `list_courses`, `get_course_contents`, `upcoming_deadlines`, `get_grades`.
4. **Arquivos**: download e leitura de PDFs/slides para a IA resumir.
5. **Escrita com confirmação**: entregas, fóruns, mensagens.
6. **Extras**: cache local, digest diário, sincronização de prazos com calendário/Notion.
