import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../config.js";
import { MoodleError, type MoodleClient } from "./client.js";
import { guessMimetype } from "./files.js";
import { formatBytes, formatDate, htmlToText, nowUnix, shortCourseName } from "./format.js";

/**
 * Entrega de tarefas (mod_assign) em duas etapas:
 *   1. planSubmission() monta e valida o que vai ser feito (prévia + código de confirmação);
 *   2. executeSubmission() só roda se o código bater com um plano idêntico ao da prévia.
 */

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const CODE_TTL_MS = 15 * 60_000;

interface AssignConfig {
  plugin: string;
  subtype: string;
  name: string;
  value: string;
}

interface AssignmentInfo {
  id: number;
  cmid: number;
  course: number;
  name: string;
  nosubmissions?: number;
  submissiondrafts?: number;
  requiresubmissionstatement?: number;
  submissionstatement?: string;
  teamsubmission?: number;
  duedate?: number;
  cutoffdate?: number;
  allowsubmissionsfromdate?: number;
  configs: AssignConfig[];
}

interface PluginFile {
  filename?: string;
  filepath?: string;
  filesize?: number;
  fileurl?: string;
}

interface Plugin {
  type: string;
  fileareas?: { area: string; files?: PluginFile[] }[];
  editorfields?: { name: string; text: string; format?: number }[];
}

interface Submission {
  status: string;
  timemodified?: number;
  plugins?: Plugin[];
}

interface SubmissionStatus {
  lastattempt?: {
    submission?: Submission;
    teamsubmission?: Submission;
    submissionsenabled?: boolean;
    locked?: boolean;
    graded?: boolean;
    canedit?: boolean;
    cansubmit?: boolean;
    extensionduedate?: number | null;
    gradingstatus?: string;
  };
  feedback?: { gradefordisplay?: string };
}

export interface LocalFile {
  path: string;
  filename: string;
  size: number;
  mtimeMs: number;
}

export interface RemoteFile {
  filename: string;
  size: number;
  fileurl: string;
}

export interface SubmissionRequest {
  assignmentId: number;
  files?: string[];
  text?: string;
  keepExistingFiles?: boolean;
  finalize?: boolean;
  acceptStatement?: boolean;
}

export interface SubmissionPlan {
  request: Required<Omit<SubmissionRequest, "files" | "text">> & { files: string[]; text?: string };
  assignment: AssignmentInfo;
  courseName: string;
  fileSubmissions: { enabled: boolean; maxFiles: number; maxBytes: number; types: string[] | null };
  textSubmissions: { enabled: boolean; wordLimit: number };
  currentStatus: string;
  currentFiles: RemoteFile[];
  currentText: string | null;
  newFiles: LocalFile[];
  keptFiles: RemoteFile[];
  removedFiles: RemoteFile[];
  /** true se depois do envio a tarefa fica "enviada para avaliação". */
  final: boolean;
  /** true se vai chamar mod_assign_submit_for_grading depois de salvar. */
  callSubmitForGrading: boolean;
  warnings: string[];
  errors: string[];
}

function cfg(a: AssignmentInfo, subtype: string, plugin: string, name: string): string | undefined {
  return a.configs.find((c) => c.subtype === subtype && c.plugin === plugin && c.name === name)?.value;
}

/** ".pdf,.docx" ou ".pdf;.zip" → [".pdf", ".docx"]. Grupos (ex.: "document") → null = não validar aqui. */
export function parseFileTypes(list: string | undefined): string[] | null {
  if (!list || list.trim() === "" || list.trim() === "*") return null;
  const items = list.split(/[\s,;]+/).filter(Boolean);
  if (items.some((t) => !t.startsWith("."))) return null;
  return items.map((t) => t.toLowerCase());
}

export function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Valida um arquivo local para envio. Bloqueia pastas/arquivos ocultos (ex.: .ssh, .aws)
 * e a pasta de dados deste projeto (onde fica o token).
 */
export async function inspectLocalFile(path: string, dataDir = DATA_DIR): Promise<LocalFile> {
  if (!isAbsolute(path)) throw new Error(`Use o caminho completo do arquivo: "${path}".`);
  const full = resolve(path);
  const rel = relative(resolve(dataDir), full);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error("Esse arquivo pertence aos dados internos do servidor e não pode ser enviado.");
  if (full.split(sep).some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..")) {
    throw new Error(`Arquivos em pastas ocultas não podem ser enviados: ${full}`);
  }
  const st = await stat(full).catch(() => null);
  if (!st) throw new Error(`Arquivo não encontrado: ${full}`);
  if (!st.isFile()) throw new Error(`Não é um arquivo: ${full}`);
  if (st.size === 0) throw new Error(`Arquivo vazio: ${full}`);
  if (st.size > MAX_UPLOAD_BYTES) throw new Error(`Arquivo grande demais (${formatBytes(st.size)}): ${full}`);
  return { path: full, filename: basename(full), size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

function submissionFiles(sub: Submission | undefined): RemoteFile[] {
  return (sub?.plugins ?? [])
    .filter((p) => p.type === "file")
    .flatMap((p) => p.fileareas ?? [])
    .flatMap((a) => a.files ?? [])
    .filter((f) => f.filename && f.filename !== "." && f.fileurl)
    .map((f) => ({ filename: f.filename!, size: f.filesize ?? 0, fileurl: f.fileurl! }));
}

function submissionText(sub: Submission | undefined): string | null {
  const field = (sub?.plugins ?? []).find((p) => p.type === "onlinetext")?.editorfields?.[0];
  return field?.text ?? null;
}

async function findAssignment(client: MoodleClient, assignmentId: number): Promise<{ a: AssignmentInfo; courseName: string }> {
  const data = await client.call<{ courses: { id: number; fullname: string; assignments: AssignmentInfo[] }[] }>(
    "mod_assign_get_assignments",
    {},
  );
  for (const c of data.courses) {
    const a = c.assignments.find((x) => x.id === assignmentId);
    if (a) return { a, courseName: shortCourseName(c.fullname) ?? c.fullname };
  }
  throw new MoodleError(`Tarefa ${assignmentId} não encontrada nas disciplinas do aluno. Use moodle_list_assignments para ver os ids.`);
}

export async function planSubmission(client: MoodleClient, req: SubmissionRequest, now = nowUnix()): Promise<SubmissionPlan> {
  const request = {
    assignmentId: req.assignmentId,
    files: req.files ?? [],
    text: req.text,
    keepExistingFiles: req.keepExistingFiles ?? true,
    finalize: req.finalize ?? false,
    acceptStatement: req.acceptStatement ?? false,
  };
  const { a, courseName } = await findAssignment(client, req.assignmentId);
  const status = await client.call<SubmissionStatus>("mod_assign_get_submission_status", { assignid: req.assignmentId });
  const attempt = status.lastattempt;
  const sub = a.teamsubmission ? attempt?.teamsubmission : attempt?.submission;

  const errors: string[] = [];
  const warnings: string[] = [];

  const fileSubmissions = {
    enabled: cfg(a, "assignsubmission", "file", "enabled") === "1",
    maxFiles: Number(cfg(a, "assignsubmission", "file", "maxfilesubmissions") ?? 1),
    maxBytes: Number(cfg(a, "assignsubmission", "file", "maxsubmissionsizebytes") ?? 0),
    types: parseFileTypes(cfg(a, "assignsubmission", "file", "filetypeslist")),
  };
  const textSubmissions = {
    enabled: cfg(a, "assignsubmission", "onlinetext", "enabled") === "1",
    wordLimit: Number(cfg(a, "assignsubmission", "onlinetext", "wordlimit") ?? 0),
  };

  // --- a tarefa aceita envio agora? ---
  if (a.nosubmissions) errors.push("Esta tarefa não recebe envios pelo Moodle (entrega fora do Moodle).");
  if (!fileSubmissions.enabled && !textSubmissions.enabled) errors.push("Esta tarefa não tem envio de arquivo nem de texto habilitado.");
  if (a.allowsubmissionsfromdate && a.allowsubmissionsfromdate > now) {
    errors.push(`Os envios só abrem em ${formatDate(a.allowsubmissionsfromdate)}.`);
  }
  const extension = attempt?.extensionduedate ?? 0;
  if (a.cutoffdate && a.cutoffdate < now && !(extension > now)) {
    errors.push(`O prazo final (data de corte) já passou: ${formatDate(a.cutoffdate)}.`);
  }
  if (attempt?.locked) errors.push("O envio está bloqueado pelo professor.");
  if (attempt && attempt.canedit === false && attempt.cansubmit !== true) {
    errors.push(
      sub?.status === "submitted"
        ? "A tarefa já foi enviada para avaliação e não pode mais ser editada pelo aluno."
        : "O Moodle não permite editar este envio agora.",
    );
  }
  const effectiveDue = extension > now ? extension : a.duedate;
  if (effectiveDue && effectiveDue < now) warnings.push(`ATRASADO: o prazo era ${formatDate(effectiveDue)}. O envio vai aparecer como atrasado.`);
  if (a.teamsubmission) warnings.push("Envio em grupo: o que for enviado vale para todo o grupo.");
  const grade = status.feedback?.gradefordisplay ? htmlToText(status.feedback.gradefordisplay) : null;
  if (grade || attempt?.graded || attempt?.gradingstatus === "graded" || attempt?.gradingstatus === "released") {
    warnings.push(
      `Esta tarefa JÁ FOI AVALIADA${grade ? ` (nota ${grade})` : ""}. Reenviar muda o que o professor vê e pode exigir nova correção.`,
    );
  }

  // --- arquivos ---
  const currentFiles = submissionFiles(sub);
  const newFiles: LocalFile[] = [];
  for (const p of request.files) {
    try {
      newFiles.push(await inspectLocalFile(p));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  const newNames = new Set(newFiles.map((f) => f.filename.toLowerCase()));
  if (newNames.size !== newFiles.length) errors.push("Há dois arquivos com o mesmo nome na lista.");

  let keptFiles: RemoteFile[] = [];
  let removedFiles: RemoteFile[] = [];
  if (request.keepExistingFiles) {
    keptFiles = currentFiles.filter((f) => !newNames.has(f.filename.toLowerCase()));
    removedFiles = currentFiles.filter((f) => newNames.has(f.filename.toLowerCase()));
  } else if (newFiles.length > 0) {
    removedFiles = currentFiles;
  } else {
    keptFiles = currentFiles; // sem arquivos novos, não apaga nada por acidente
  }

  if (newFiles.length > 0) {
    if (!fileSubmissions.enabled) errors.push("Esta tarefa não aceita envio de arquivos.");
    const total = keptFiles.length + newFiles.length;
    if (fileSubmissions.enabled && total > fileSubmissions.maxFiles) {
      errors.push(`A tarefa aceita no máximo ${fileSubmissions.maxFiles} arquivo(s); o envio teria ${total}.`);
    }
    for (const f of newFiles) {
      if (fileSubmissions.maxBytes && f.size > fileSubmissions.maxBytes) {
        errors.push(`${f.filename} passa do limite de ${formatBytes(fileSubmissions.maxBytes)} por arquivo.`);
      }
      const ext = f.filename.includes(".") ? f.filename.slice(f.filename.lastIndexOf(".")).toLowerCase() : "";
      if (fileSubmissions.types && !fileSubmissions.types.includes(ext)) {
        errors.push(`${f.filename}: tipo não aceito. Tipos aceitos: ${fileSubmissions.types.join(", ")}.`);
      }
    }
  }

  // --- texto ---
  const currentText = submissionText(sub);
  if (request.text !== undefined) {
    if (!textSubmissions.enabled) errors.push("Esta tarefa não aceita texto online.");
    const words = countWords(request.text);
    if (textSubmissions.wordLimit && words > textSubmissions.wordLimit) {
      errors.push(`O texto tem ${words} palavras; o limite é ${textSubmissions.wordLimit}.`);
    }
  }

  // --- finalização ---
  const drafts = a.submissiondrafts === 1;
  const changesContent = newFiles.length > 0 || request.text !== undefined || removedFiles.length > 0;
  const callSubmitForGrading = drafts && request.finalize;
  if (!changesContent && !callSubmitForGrading) {
    errors.push(
      drafts
        ? "Nada a fazer: informe arquivos, texto ou finalize=true para enviar o rascunho atual para avaliação."
        : "Nada a fazer: informe os arquivos (ou o texto) a enviar.",
    );
  }
  if (callSubmitForGrading && a.requiresubmissionstatement && !request.acceptStatement) {
    errors.push("Esta tarefa exige aceitar a declaração de autoria. Mostre o texto ao aluno e, se ele concordar, use acceptStatement=true.");
  }
  if (callSubmitForGrading && !changesContent && currentFiles.length === 0 && !currentText) {
    errors.push("Não há nada no rascunho para enviar para avaliação.");
  }

  return {
    request,
    assignment: a,
    courseName,
    fileSubmissions,
    textSubmissions,
    currentStatus: sub?.status ?? "new",
    currentFiles,
    currentText,
    newFiles,
    keptFiles,
    removedFiles,
    final: !drafts || callSubmitForGrading,
    callSubmitForGrading,
    warnings,
    errors,
  };
}

// ---------- código de confirmação ----------

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

function submitPayload(plan: SubmissionPlan) {
  return {
    r: plan.request,
    n: plan.newFiles.map((f) => [f.path, f.size, f.mtimeMs]),
    c: plan.currentFiles.map((f) => [f.filename, f.size]),
    s: plan.currentStatus,
    f: plan.final,
  };
}

export function issueConfirmationCode(plan: SubmissionPlan, nowMs = Date.now()): string {
  return issueCode("submit", submitPayload(plan), nowMs);
}

export function checkConfirmationCode(plan: SubmissionPlan, code: string, nowMs = Date.now()): string | null {
  const problem = checkCode("submit", submitPayload(plan), code, nowMs);
  return problem?.startsWith("A ação mudou")
    ? "O envio mudou desde a prévia (arquivos, texto, opções ou estado no Moodle). Gere uma nova prévia e confirme de novo com o aluno."
    : problem;
}

// ---------- remoção do envio ----------

export interface RemovalPlan {
  assignment: AssignmentInfo;
  courseName: string;
  currentStatus: string;
  currentFiles: RemoteFile[];
  hasText: boolean;
  team: boolean;
  warnings: string[];
  errors: string[];
}

export async function planRemoval(client: MoodleClient, assignmentId: number): Promise<RemovalPlan> {
  const { a, courseName } = await findAssignment(client, assignmentId);
  const status = await client.call<SubmissionStatus>("mod_assign_get_submission_status", { assignid: assignmentId });
  const attempt = status.lastattempt;
  const team = Boolean(a.teamsubmission);
  const sub = team ? attempt?.teamsubmission : attempt?.submission;
  const currentFiles = submissionFiles(sub);
  const text = submissionText(sub);
  const hasText = Boolean(text && htmlToText(text));

  const errors: string[] = [];
  const warnings: string[] = [];
  if (currentFiles.length === 0 && !hasText) errors.push("Não há nada no envio desta tarefa para remover.");
  if (attempt?.locked) errors.push("O envio está bloqueado pelo professor.");
  if (attempt && attempt.canedit === false) errors.push("O Moodle não permite editar (nem remover) este envio agora.");
  if (team) warnings.push("Envio em grupo: a remoção apaga o envio do GRUPO INTEIRO, inclusive arquivos enviados por colegas.");
  const grade = status.feedback?.gradefordisplay ? htmlToText(status.feedback.gradefordisplay) : null;
  if (grade) warnings.push(`Esta tarefa já foi avaliada (nota ${grade}).`);

  return { assignment: a, courseName, currentStatus: sub?.status ?? "new", currentFiles, hasText, team, warnings, errors };
}

function removalPayload(plan: RemovalPlan) {
  return { a: plan.assignment.id, s: plan.currentStatus, f: plan.currentFiles.map((f) => [f.filename, f.size]), t: plan.hasText };
}

export function issueRemovalCode(plan: RemovalPlan, nowMs = Date.now()): string {
  return issueCode("remove", removalPayload(plan), nowMs);
}

export function checkRemovalCode(plan: RemovalPlan, code: string, nowMs = Date.now()): string | null {
  return checkCode("remove", removalPayload(plan), code, nowMs);
}

export function describeRemoval(plan: RemovalPlan): string {
  const lines = [
    `Tarefa: ${plan.assignment.name}`,
    `Disciplina: ${plan.courseName}`,
    `Situação atual: ${STATUS_PT[plan.currentStatus] ?? plan.currentStatus}`,
  ];
  if (plan.currentFiles.length || plan.hasText) {
    lines.push("", "Será APAGADO do envio:");
    for (const f of plan.currentFiles) lines.push(`  − ${f.filename} (${formatBytes(f.size)})`);
    if (plan.hasText) lines.push("  − o texto online");
  }
  if (plan.warnings.length) lines.push("", "Atenção:", ...plan.warnings.map((w) => `  ! ${w}`));
  if (plan.errors.length) lines.push("", "NÃO É POSSÍVEL REMOVER:", ...plan.errors.map((e) => `  ✗ ${e}`));
  return lines.join("\n");
}

export async function executeRemoval(client: MoodleClient, plan: RemovalPlan, userid: number): Promise<void> {
  const r = await client.call<{ status: boolean; warnings?: { message: string }[] }>("mod_assign_remove_submission", {
    userid,
    assignid: plan.assignment.id,
  });
  if (!r?.status || r.warnings?.length) {
    throw new MoodleError(`O Moodle não removeu o envio: ${(r?.warnings ?? []).map((w) => w.message).join("; ") || "sem detalhes"}`);
  }
}

// ---------- prévia ----------

const STATUS_PT: Record<string, string> = {
  new: "nada enviado",
  draft: "rascunho (não enviado para avaliação)",
  submitted: "enviado para avaliação",
  reopened: "reaberto",
};

export function describePlan(plan: SubmissionPlan): string {
  const a = plan.assignment;
  const lines: string[] = [];
  lines.push(`Tarefa: ${a.name}`, `Disciplina: ${plan.courseName}`);
  if (a.duedate) lines.push(`Prazo: ${formatDate(a.duedate)}${a.cutoffdate ? ` · corte: ${formatDate(a.cutoffdate)}` : ""}`);
  lines.push(`Situação atual: ${STATUS_PT[plan.currentStatus] ?? plan.currentStatus}`);

  if (plan.newFiles.length || plan.keptFiles.length || plan.removedFiles.length) {
    lines.push("", "Arquivos do envio:");
    for (const f of plan.newFiles) lines.push(`  + ${f.filename} (${formatBytes(f.size)}) ← ${f.path}`);
    for (const f of plan.keptFiles) lines.push(`  = ${f.filename} (${formatBytes(f.size)}) — já estava no Moodle, mantido`);
    for (const f of plan.removedFiles) lines.push(`  − ${f.filename} (${formatBytes(f.size)}) — será removido/substituído`);
  }
  if (plan.request.text !== undefined) {
    lines.push("", `Texto online (${countWords(plan.request.text)} palavras):`, indent(plan.request.text.slice(0, 600) + (plan.request.text.length > 600 ? "…" : "")));
  }

  lines.push("");
  if (plan.final) {
    lines.push(
      plan.callSubmitForGrading
        ? "Depois de salvar, o envio será ENVIADO PARA AVALIAÇÃO (entrega final)."
        : "Nesta tarefa, salvar o envio já é a ENTREGA FINAL (não existe rascunho).",
    );
  } else {
    lines.push("O envio ficará como RASCUNHO; ainda não será enviado para avaliação (use finalize=true para entregar).");
  }
  if (plan.callSubmitForGrading && a.requiresubmissionstatement) {
    lines.push("", "Declaração que o aluno está aceitando:", indent(htmlToText(a.submissionstatement) || "(texto da declaração não disponível)"));
  }
  if (plan.warnings.length) lines.push("", "Atenção:", ...plan.warnings.map((w) => `  ! ${w}`));
  if (plan.errors.length) lines.push("", "NÃO É POSSÍVEL ENVIAR:", ...plan.errors.map((e) => `  ✗ ${e}`));
  return lines.join("\n");
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

// ---------- execução ----------

export async function executeSubmission(client: MoodleClient, plan: SubmissionPlan): Promise<void> {
  const changesContent = plan.newFiles.length > 0 || plan.request.text !== undefined || plan.removedFiles.length > 0;

  if (changesContent) {
    const plugindata: Record<string, unknown> = {};

    if (plan.fileSubmissions.enabled) {
      const itemid = await client.newDraftItemId();
      // Arquivos que ficam: baixa do Moodle e sobe de novo na nova área de rascunho.
      for (const f of plan.keptFiles) {
        const { bytes, contentType } = await client.downloadFile(f.fileurl);
        await client.uploadDraftFile(itemid, f.filename, bytes, guessMimetype(f.filename, contentType));
      }
      for (const f of plan.newFiles) {
        const bytes = new Uint8Array(await readFile(f.path));
        if (bytes.byteLength !== f.size) throw new Error(`${f.filename} mudou depois da prévia. Gere uma nova prévia.`);
        await client.uploadDraftFile(itemid, f.filename, bytes, guessMimetype(f.filename));
      }
      plugindata.files_filemanager = itemid;
    }

    if (plan.textSubmissions.enabled) {
      const text = plan.request.text ?? plan.currentText ?? "";
      plugindata.onlinetext_editor = {
        text: plan.request.text !== undefined ? escapeAsHtml(text) : text,
        format: 1,
        itemid: await client.newDraftItemId(),
      };
    }

    const warnings = await client.call<{ item?: string; message: string; warningcode?: string }[]>(
      "mod_assign_save_submission",
      { assignmentid: plan.assignment.id, plugindata: plugindata as never },
    );
    if (warnings?.length) throw new MoodleError(`O Moodle não salvou o envio: ${warnings.map((w) => w.message).join("; ")}`);
  }

  if (plan.callSubmitForGrading) {
    const warnings = await client.call<{ message: string }[]>("mod_assign_submit_for_grading", {
      assignmentid: plan.assignment.id,
      acceptsubmissionstatement: plan.request.acceptStatement,
    });
    if (warnings?.length) throw new MoodleError(`O Moodle não enviou para avaliação: ${warnings.map((w) => w.message).join("; ")}`);
  }
}

/** Texto puro do aluno → HTML simples (o editor do Moodle guarda HTML). */
export function escapeAsHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
