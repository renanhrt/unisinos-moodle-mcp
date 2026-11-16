import { createHash, randomBytes } from "node:crypto";

/**
 * Fluxo de login do app oficial do Moodle (admin/tool/mobile/launch.php).
 *
 * Depois do login (SSO), o Moodle redireciona para
 *   moodlemobile://token=<base64( md5(wwwroot + passport) ":::" token [":::" privatetoken] )>
 * A assinatura md5 prova que a resposta veio do site e do pedido certos.
 */

export const URL_SCHEME = "moodlemobile";

export function newPassport(): string {
  return randomBytes(16).toString("hex");
}

export function buildLaunchUrl(siteUrl: string, service: string, passport: string): string {
  const u = new URL(`${siteUrl.replace(/\/+$/, "")}/admin/tool/mobile/launch.php`);
  u.searchParams.set("service", service);
  u.searchParams.set("passport", passport);
  u.searchParams.set("urlscheme", URL_SCHEME);
  return u.toString();
}

/** Procura `moodlemobile://token=...` em uma URL, header Location ou HTML. */
export function findLaunchToken(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /moodlemobile:\/\/token=([A-Za-z0-9+/=_%-]+)/.exec(text);
  return m ? decodeURIComponent(m[1]!) : null;
}

export class LaunchTokenError extends Error {}

/** Decodifica e valida o valor de `token=`. Lança se a assinatura não bater. */
export function decodeLaunchToken(
  encoded: string,
  siteUrl: string,
  passport: string,
): { token: string; privateToken?: string } {
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [signature, token, privateToken] = decoded.split(":::");
  if (!signature || !token) throw new LaunchTokenError("Formato de token inesperado.");

  const expected = createHash("md5").update(siteUrl.replace(/\/+$/, "") + passport).digest("hex");
  if (signature !== expected) {
    throw new LaunchTokenError("Assinatura do token não confere (site ou passport diferente). Token descartado.");
  }
  if (!/^[a-zA-Z0-9]{32}$/.test(token)) throw new LaunchTokenError("Token com formato inválido.");
  return privateToken ? { token, privateToken } : { token };
}
