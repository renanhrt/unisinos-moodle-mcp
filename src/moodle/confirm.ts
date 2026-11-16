import { createHash, createHmac, randomBytes } from "node:crypto";

/**
 * Códigos de confirmação para ações que alteram o Moodle (entregar, remover, postar, enviar mensagem).
 *
 * A ferramenta primeiro devolve uma prévia + código; a ação só roda quando o mesmo código volta
 * E a ação recalculada é idêntica à da prévia. O código vale 15 min, é de uso único e é ligado ao
 * tipo da ação: um código de "remover" não autoriza "enviar mensagem".
 */

const CODE_TTL_MS = 15 * 60_000;
const secret = randomBytes(32);
const issued = new Map<string, number>();

/**
 * Identidade de uma ação: o tipo ("submit", "remove"…) + tudo que define o que vai acontecer.
 * Qualquer mudança (arquivo no disco, opção, estado no Moodle) gera outra identidade.
 */
function fingerprint(kind: string, payload: unknown): string {
  return createHash("sha256").update(kind).update("\u0000").update(JSON.stringify(payload)).digest("hex");
}

function codeFor(fp: string): string {
  return createHmac("sha256", secret).update(fp).digest("hex").slice(0, 8).toUpperCase();
}

/** Emite um código de confirmação (15 min, uso único) para esta ação exata. */
export function issueCode(kind: string, payload: unknown, nowMs = Date.now()): string {
  const code = codeFor(fingerprint(kind, payload));
  issued.set(code, nowMs + CODE_TTL_MS);
  for (const [k, exp] of issued) if (exp < nowMs) issued.delete(k);
  return code;
}

/** null = código válido (e consumido); string = motivo da recusa. */
export function checkCode(kind: string, payload: unknown, code: string, nowMs = Date.now()): string | null {
  const normalized = code.trim().toUpperCase();
  const exp = issued.get(normalized);
  if (!exp) return "Código de confirmação desconhecido. Gere uma nova prévia (sem confirmationCode).";
  if (exp < nowMs) {
    issued.delete(normalized);
    return "Código de confirmação expirado (15 min). Gere uma nova prévia.";
  }
  if (codeFor(fingerprint(kind, payload)) !== normalized) {
    return "A ação mudou desde a prévia (arquivos, opções ou estado no Moodle). Gere uma nova prévia e confirme de novo com o aluno.";
  }
  issued.delete(normalized); // uso único
  return null;
}

