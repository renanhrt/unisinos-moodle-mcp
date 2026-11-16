import { rm } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BROWSER_PROFILE_DIR, CREDENTIALS_FILE, MOODLE_URL } from "../config.js";
import { login } from "../auth/login.js";
import { deleteCredentials, type StoredCredentials } from "../auth/store.js";
import { MoodleError } from "../moodle/client.js";
import { getSession, NotLoggedInError, resetSession } from "../moodle/session.js";

/**
 * Login pelo próprio chat: a ferramenta abre o navegador e responde logo (o login pode
 * levar minutos, mais que o tempo limite de uma chamada). Chamar de novo informa o andamento.
 */

interface PendingLogin {
  startedAt: number;
  done: boolean;
  result?: StoredCredentials;
  error?: string;
  promise: Promise<void>;
}

let pending: PendingLogin | null = null;

/** Para testes: troca a função que faz o login de verdade (abre o navegador). */
let loginImpl: () => Promise<StoredCredentials> = () => login((m) => console.error(m));
let waitMs = 20_000;
export function setLoginImplForTests(fn: () => Promise<StoredCredentials>, wait = 20_000): void {
  loginImpl = fn;
  waitMs = wait;
  pending = null;
}

function startLogin(): PendingLogin {
  const p: PendingLogin = { startedAt: Date.now(), done: false, promise: Promise.resolve() };
  p.promise = loginImpl()
    .then((creds) => {
      p.result = creds;
      resetSession();
    })
    .catch((err: unknown) => {
      p.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      p.done = true;
    });
  return p;
}

async function waitFor(p: PendingLogin, ms: number): Promise<void> {
  await Promise.race([p.promise, new Promise((r) => setTimeout(r, ms))]);
}

function report(p: PendingLogin): CallToolResult {
  if (p.done && p.result) {
    pending = null;
    return text(`✅ Conectado ao Moodle como ${p.result.fullname} (${p.result.username}). Já dá para usar as outras ferramentas.`);
  }
  if (p.done) {
    pending = null;
    return text(`❌ O login não foi concluído: ${p.error ?? "erro desconhecido"}. Para tentar de novo, chame moodle_login.`, true);
  }
  const min = Math.floor((Date.now() - p.startedAt) / 60_000);
  return text(
    "🔐 Abri uma janela do navegador no login da Microsoft da Unisinos. Peça ao aluno para entrar com a conta institucional " +
      "(e confirmar o MFA, se pedir). Se aparecer uma página perguntando sobre abrir o app, ele deve clicar para continuar. " +
      `A janela fecha sozinha ao terminar. Quando o aluno disser que terminou, chame moodle_login de novo para confirmar.` +
      (min >= 1 ? ` (aguardando há ${min} min; o limite é 5 min)` : ""),
  );
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export function registerAuthTools(server: McpServer): void {
  server.registerTool(
    "moodle_login",
    {
      title: "Conectar ao Moodle",
      description:
        "Conecta o aluno ao Moodle da Unisinos: abre o navegador no login da Microsoft e guarda o acesso neste computador. " +
        "Use quando o aluno pedir para conectar/entrar, ou quando outra ferramenta disser que não há login ou que ele expirou. " +
        "Se já estiver conectado, só informa quem está logado. Chame de novo para saber se o login terminou.",
      inputSchema: {
        force: z.boolean().default(false).describe("fazer um login novo mesmo já estando conectado (ex.: trocar de conta)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ force }): Promise<CallToolResult> => {
      try {
        if (pending) {
          await waitFor(pending, waitMs);
          return report(pending);
        }
        if (process.env.MOODLE_TOKEN) {
          return text("Este servidor está usando um token fixo (variável MOODLE_TOKEN); o login pelo navegador está desativado.", true);
        }
        if (!force) {
          try {
            const { site } = await getSession();
            return text(`Já está conectado ao Moodle como ${site.fullname} (${site.username}). Para trocar de conta use force=true.`);
          } catch (err) {
            if (!(err instanceof NotLoggedInError) && !(err instanceof MoodleError && err.isAuthError)) throw err;
          }
        }
        pending = startLogin();
        await waitFor(pending, waitMs);
        return report(pending);
      } catch (err) {
        return text(`Erro ao conectar: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );

  server.registerTool(
    "moodle_logout",
    {
      title: "Desconectar do Moodle",
      description:
        "Apaga o acesso ao Moodle guardado neste computador. Com forgetBrowser=true também apaga a sessão da Microsoft " +
        "salva no navegador do MCP (útil em computador compartilhado). Não altera nada no Moodle.",
      inputSchema: {
        forgetBrowser: z.boolean().default(false).describe("também esquecer a conta Microsoft no navegador usado pelo login"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ forgetBrowser }): Promise<CallToolResult> => {
      await deleteCredentials();
      if (forgetBrowser) await rm(BROWSER_PROFILE_DIR, { recursive: true, force: true });
      resetSession();
      pending = null;
      return text(
        `Desconectado do Moodle (${MOODLE_URL}). O acesso salvo em ${CREDENTIALS_FILE} foi apagado` +
          (forgetBrowser ? " e a sessão da Microsoft no navegador do MCP também." : ".") +
          " Para entrar de novo, use moodle_login.",
      );
    },
  );
}
