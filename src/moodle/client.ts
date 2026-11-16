/**
 * Cliente mínimo da API REST de Web Services do Moodle.
 * Docs: https://docs.moodle.org/dev/Web_service_API_functions
 */

export type MoodleParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | MoodleParamValue[]
  | { [key: string]: MoodleParamValue };

export class MoodleError extends Error {
  constructor(
    message: string,
    readonly errorcode?: string,
    readonly exception?: string,
  ) {
    super(message);
    this.name = "MoodleError";
  }

  /** Token inválido, expirado ou revogado: o usuário precisa logar de novo. */
  get isAuthError(): boolean {
    return (
      this.errorcode === "invalidtoken" ||
      this.errorcode === "accessexception" ||
      this.errorcode === "invalidlogin"
    );
  }
}

/**
 * Converte objetos/arrays aninhados no formato que o Moodle espera em
 * application/x-www-form-urlencoded: `courseids[0]=1`, `options[0][name]=x`.
 * Booleanos viram 1/0; null/undefined são omitidos.
 */
export function flattenParams(
  params: Record<string, MoodleParamValue>,
  prefix = "",
  out: [string, string][] = [],
): [string, string][] {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      flattenParams(Object.fromEntries(value.map((v, i) => [String(i), v])), name, out);
    } else if (typeof value === "object") {
      flattenParams(value, name, out);
    } else if (typeof value === "boolean") {
      out.push([name, value ? "1" : "0"]);
    } else {
      out.push([name, String(value)]);
    }
  }
  return out;
}

export interface MoodleClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Idioma das strings devolvidas (moodlewssettinglang), ex.: "pt_br". */
  lang?: string;
}

export class MoodleClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly lang?: string;

  constructor(opts: MoodleClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.lang = opts.lang;
  }

  /** Chama uma função de Web Service e devolve o JSON já checado por erro. */
  async call<T = unknown>(wsfunction: string, params: Record<string, MoodleParamValue> = {}): Promise<T> {
    const lang = this.lang ? `&moodlewssettinglang=${encodeURIComponent(this.lang)}` : "";
    const url = `${this.baseUrl}/webservice/rest/server.php?moodlewsrestformat=json${lang}&wsfunction=${encodeURIComponent(wsfunction)}`;
    const body = new URLSearchParams([["wstoken", this.token], ...flattenParams(params)]);

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new MoodleError(`HTTP ${res.status} ao chamar ${wsfunction}`);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text.length ? JSON.parse(text) : null;
    } catch {
      throw new MoodleError(`Resposta inválida (não é JSON) ao chamar ${wsfunction}`);
    }
    if (data && typeof data === "object" && !Array.isArray(data) && "exception" in data) {
      const e = data as { message?: string; errorcode?: string; exception?: string };
      throw new MoodleError(e.message ?? "Erro do Moodle", e.errorcode, e.exception);
    }
    return data as T;
  }

  /**
   * URLs de arquivos do Moodle (pluginfile.php) precisam do token para baixar
   * fora do navegador. Use apenas internamente; não devolva essa URL à IA.
   */
  authenticatedFileUrl(fileurl: string): string {
    const u = this.checkFileUrl(fileurl);
    if (!u.pathname.includes("/webservice/pluginfile.php")) {
      u.pathname = u.pathname.replace("/pluginfile.php", "/webservice/pluginfile.php");
    }
    u.searchParams.set("token", this.token);
    return u.toString();
  }

  /**
   * Só aceita arquivos do próprio Moodle (pluginfile.php no mesmo domínio).
   * Isso impede que uma URL vinda de texto não confiável faça o token vazar para outro site.
   */
  checkFileUrl(fileurl: string): URL {
    let u: URL;
    try {
      u = new URL(fileurl);
    } catch {
      throw new MoodleError("URL de arquivo inválida.");
    }
    if (u.origin !== new URL(this.baseUrl).origin) {
      throw new MoodleError(`Só é possível baixar arquivos de ${this.baseUrl}.`);
    }
    if (!/\/(webservice\/)?pluginfile\.php\//.test(u.pathname)) {
      throw new MoodleError("A URL não é um arquivo do Moodle (pluginfile.php). Use o fileurl devolvido pelas outras ferramentas.");
    }
    u.searchParams.delete("token");
    return u;
  }

  async downloadFile(
    fileurl: string,
    maxBytes = 50 * 1024 * 1024,
  ): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const res = await this.fetchImpl(this.authenticatedFileUrl(fileurl), {
      signal: AbortSignal.timeout(this.timeoutMs * 4),
      // Não seguir redirects: a URL carrega o token.
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) throw new MoodleError("O Moodle redirecionou o download; arquivo indisponível.");
    if (!res.ok) throw new MoodleError(`HTTP ${res.status} ao baixar arquivo`);
    const contentType = res.headers.get("content-type");
    // O Moodle responde erros de token em JSON mesmo no pluginfile.
    if (contentType?.includes("application/json")) {
      const data = (await res.json()) as { error?: string; errorcode?: string; message?: string };
      throw new MoodleError(data.error ?? data.message ?? "Erro ao baixar arquivo", data.errorcode);
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new MoodleError(`Arquivo grande demais (${Math.round(declared / 1048576)} MB).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new MoodleError("Arquivo grande demais.");
    return { bytes, contentType };
  }
}
