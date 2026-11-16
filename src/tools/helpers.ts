import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MoodleError } from "../moodle/client.js";
import { getSession, NotLoggedInError, resetSession, type Session } from "../moodle/session.js";

/**
 * Executa uma ferramenta com a sessão do Moodle e devolve o resultado como JSON.
 * Erros viram `isError: true` com uma mensagem útil para a IA repassar ao aluno.
 */
export async function runTool(fn: (session: Session) => Promise<unknown>): Promise<CallToolResult> {
  try {
    const session = await getSession();
    const result = await fn(session);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: describeError(err) }] };
  }
}

export function describeError(err: unknown): string {
  if (err instanceof NotLoggedInError) return err.message;
  if (err instanceof MoodleError) {
    if (err.isAuthError) {
      resetSession();
      return "O token do Moodle é inválido ou expirou. Peça ao aluno para rodar `npm run login` no projeto unisinos-moodle-mcp.";
    }
    return `Erro do Moodle${err.errorcode ? ` (${err.errorcode})` : ""}: ${err.message}`;
  }
  if (err instanceof Error && err.name === "TimeoutError") return "O Moodle demorou demais para responder. Tente de novo.";
  return `Erro inesperado: ${err instanceof Error ? err.message : String(err)}`;
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
