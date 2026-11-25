import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MoodleError, type MoodleClient } from "../moodle/client.js";
import { compact, formatDate, htmlToText, nowUnix, shortCourseName } from "../moodle/format.js";
import { AnswerError, buildAnswerData, currentAnswer, parseQuestionHtml, type ParsedQuestion } from "../moodle/quiz-html.js";
import { getSession } from "../moodle/session.js";
import { getEnrolledCourses } from "./courses.js";
import {
  CONFIRMATION_CODE_DESC,
  CONFIRMATION_RULE,
  confirmedAction,
  describeError,
  READ_ONLY,
  runTool,
  WRITES_MOODLE,
} from "./helpers.js";

/**
 * Questionários: o MCP funciona como o app oficial — mostra as questões e marca
 * SOMENTE a resposta que o aluno disser. A IA não sugere, não resolve e não escolhe
 * respostas em questionários.
 */
export const QUIZ_RULE =
  "REGRA: em questionários a IA NÃO sugere, NÃO resolve e NÃO escolhe respostas; só mostra as questões e marca exatamente " +
  "a opção que o aluno disser explicitamente. Se o aluno pedir a resposta, recuse e ofereça explicar o conteúdo depois, em estudo.";

interface Quiz {
  id: number;
  coursemodule: number;
  course: number;
  name: string;
  intro?: string;
  timeopen?: number;
  timeclose?: number;
  timelimit?: number;
  attempts?: number;
  grade?: number;
  sumgrades?: number;
  navmethod?: string;
  preferredbehaviour?: string;
  hasquestions?: number;
}

interface Attempt {
  id: number;
  attempt: number;
  uniqueid: number;
  state: string;
  timestart?: number;
  timefinish?: number;
  sumgrades?: number | null;
  currentpage?: number;
  layout?: string;
}

interface AccessInfo {
  canattempt: boolean;
  canreviewmyattempts: boolean;
  activerulenames: string[];
  preventaccessreasons: string[];
}

interface AttemptQuestion {
  slot: number;
  type: string;
  page: number;
  html: string;
  number?: number;
  status?: string;
  state?: string;
  maxmark?: number;
  mark?: string;
  blockedbyprevious?: boolean;
  flagged?: boolean;
}

/** Regras de acesso que o MCP sabe respeitar sem o navegador. */
const SUPPORTED_RULES = new Set([
  "quizaccess_numattempts",
  "quizaccess_openclosedate",
  "quizaccess_timelimit",
  "quizaccess_delaybetweenattempts",
]);

const STATE_PT: Record<string, string> = {
  inprogress: "em andamento",
  overdue: "tempo esgotado (aguardando envio)",
  finished: "finalizada",
  abandoned: "abandonada",
};

async function findQuiz(client: MoodleClient, userid: number, quizId: number) {
  const courses = await getEnrolledCourses(client, userid);
  const r = await client.call<{ quizzes: Quiz[] }>("mod_quiz_get_quizzes_by_courses", { courseids: courses.map((c) => c.id) });
  const quiz = r.quizzes.find((q) => q.id === quizId);
  if (!quiz) throw new MoodleError(`Questionário ${quizId} não encontrado. Use moodle_list_quizzes.`);
  return { quiz, courseName: shortCourseName(courses.find((c) => c.id === quiz.course)?.fullname) ?? "" };
}

async function attemptsOf(client: MoodleClient, quizId: number): Promise<Attempt[]> {
  const r = await client.call<{ attempts: Attempt[] }>("mod_quiz_get_user_attempts", { quizid: quizId, status: "all", includepreviews: false });
  return r.attempts;
}

/**
 * Descobre a qual questionário uma tentativa pertence (e o tipo de navegação) SEM abrir
 * nenhuma página — em navegação sequencial, abrir a página seguinte avança sem volta.
 */
async function locateAttempt(client: MoodleClient, userid: number, attemptId: number): Promise<{ quiz: Quiz; attempt: Attempt }> {
  const courses = await getEnrolledCourses(client, userid);
  const r = await client.call<{ quizzes: Quiz[] }>("mod_quiz_get_quizzes_by_courses", { courseids: courses.map((c) => c.id) });
  for (const quiz of r.quizzes) {
    const attempt = (await attemptsOf(client, quiz.id)).find((a) => a.id === attemptId);
    if (attempt) return { quiz, attempt };
  }
  throw new MoodleError(`Tentativa ${attemptId} não encontrada entre os questionários do aluno.`);
}

const isSequential = (quiz: Quiz) => quiz.navmethod === "sequential";

async function getPage(client: MoodleClient, attemptId: number, page: number) {
  return client.call<{ attempt: Attempt; nextpage: number; questions: AttemptQuestion[]; messages: string[] }>(
    "mod_quiz_get_attempt_data",
    { attemptid: attemptId, page },
  );
}

function questionView(q: AttemptQuestion, parsed: ParsedQuestion) {
  return compact({
    slot: q.slot,
    number: q.number ?? parsed.number,
    page: q.page + 1,
    status: q.status,
    points: q.maxmark,
    text: parsed.text,
    images: parsed.images,
    prompt: parsed.prompt,
    options: parsed.radio?.options.map((o) => `${o.letter}) ${o.text}`),
    multipleOptions: parsed.checkboxes?.map((o) => `${o.letter}) ${o.text}`),
    textFields: parsed.texts?.map((t) => t.label),
    lists: parsed.selects?.map((s) => ({ field: s.label, options: s.options.map((o, i) => `${String.fromCharCode(97 + i)}) ${o.text}`) })),
    essay: parsed.essays ? true : null,
    markedNow: currentAnswer(parsed),
    blocked: q.blockedbyprevious || null,
  });
}

function timeLeft(quiz: Quiz, attempt: Attempt): string | null {
  if (!quiz.timelimit || !attempt.timestart) return null;
  const left = attempt.timestart + quiz.timelimit - nowUnix();
  if (left <= 0) return "tempo esgotado";
  return `${Math.floor(left / 60)} min ${left % 60} s`;
}

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export function registerQuizTools(server: McpServer): void {
  server.registerTool(
    "moodle_list_quizzes",
    {
      title: "Listar questionários",
      description: "Lista os questionários das disciplinas: abertura, fechamento, tempo, tentativas usadas/permitidas, tentativa em andamento e nota.",
      inputSchema: {
        courseids: z.array(z.number().int().positive()).optional().describe("limitar a estas disciplinas (padrão: todas)"),
      },
      annotations: READ_ONLY,
    },
    ({ courseids }) =>
      runTool(async ({ client, site }) => {
        const courses = await getEnrolledCourses(client, site.userid);
        const names = new Map(courses.map((c) => [c.id, shortCourseName(c.fullname)]));
        const r = await client.call<{ quizzes: Quiz[] }>("mod_quiz_get_quizzes_by_courses", {
          courseids: courseids ?? courses.map((c) => c.id),
        });
        const now = nowUnix();
        const out = [];
        for (const q of r.quizzes) {
          const [attempts, best] = await Promise.all([
            attemptsOf(client, q.id),
            client.call<{ hasgrade: boolean; grade?: number }>("mod_quiz_get_user_best_grade", { quizid: q.id }),
          ]);
          const open = (!q.timeopen || q.timeopen <= now) && (!q.timeclose || q.timeclose > now);
          const inProgress = attempts.find((a) => a.state === "inprogress" || a.state === "overdue");
          const used = attempts.filter((a) => a.state !== "inprogress").length;
          out.push(
            compact({
              quizId: q.id,
              name: q.name,
              course: names.get(q.course),
              status: q.timeopen && q.timeopen > now ? "ainda não abriu" : open ? "aberto" : "fechado",
              opens: formatDate(q.timeopen),
              closes: formatDate(q.timeclose),
              timeLimit: q.timelimit ? `${Math.round(q.timelimit / 60)} min` : "sem limite",
              attempts: `${used + (inProgress ? 1 : 0)} de ${q.attempts || "∞"}`,
              inProgressAttemptId: inProgress?.id,
              bestGrade: best.hasgrade ? `${best.grade} de ${q.grade}` : null,
              maxGrade: q.grade,
            }),
          );
        }
        return out;
      }),
  );

  server.registerTool(
    "moodle_quiz_start",
    {
      title: "Abrir questionário",
      description:
        "Abre um questionário para o aluno responder pelo MCP. Se já houver tentativa em andamento, apenas a retoma. " +
        `Iniciar uma tentativa NOVA gasta uma das tentativas e inicia o cronômetro (se houver), por isso ${CONFIRMATION_RULE} ${QUIZ_RULE}`,
      inputSchema: {
        quizId: z.number().int().positive().describe("quizId (de moodle_list_quizzes ou moodle_upcoming_deadlines); não é o cmid"),
        confirmationCode: z.string().optional().describe(CONFIRMATION_CODE_DESC + " (só para tentativa nova)"),
      },
      annotations: WRITES_MOODLE,
    },
    async ({ quizId, confirmationCode }): Promise<CallToolResult> => {
      try {
        const { client, site } = await getSession();
        const { quiz, courseName } = await findQuiz(client, site.userid, quizId);
        const attempts = await attemptsOf(client, quizId);
        const current = attempts.find((a) => a.state === "inprogress" || a.state === "overdue");
        if (current) {
          return text(
            `Tentativa em andamento retomada (attemptId ${current.id}, tentativa nº ${current.attempt}).\n` +
              (timeLeft(quiz, current) ? `Tempo restante: ${timeLeft(quiz, current)}.\n` : "") +
              `Use moodle_quiz_questions com attemptId=${current.id}.`,
          );
        }

        const access = await client.call<AccessInfo>("mod_quiz_get_quiz_access_information", { quizid: quizId });
        const errors = [...access.preventaccessreasons.map(htmlToText)];
        if (!access.canattempt) errors.push("O Moodle não permite que este usuário responda este questionário.");
        const unsupported = access.activerulenames.filter((r) => !SUPPORTED_RULES.has(r));
        if (unsupported.length) {
          errors.push(`Este questionário tem regras que exigem o navegador (${unsupported.join(", ")}). Responda pelo Moodle.`);
        }
        const used = attempts.length;
        const preview = [
          `Questionário: ${quiz.name} — ${courseName}`,
          `Fecha: ${formatDate(quiz.timeclose) ?? "sem data"} · Tempo: ${quiz.timelimit ? `${Math.round(quiz.timelimit / 60)} min` : "sem limite"} · Vale: ${quiz.grade ?? "?"} pontos`,
          `Tentativas: esta será a ${used + 1}ª de ${quiz.attempts || "∞"}.`,
          "",
          "Atenção:",
          "  ! Iniciar a tentativa já conta como uma tentativa, mesmo que você não responda nada.",
          ...(quiz.timelimit ? ["  ! O cronômetro começa agora e continua correndo mesmo fora do MCP."] : []),
        ].join("\n");

        return confirmedAction({
          kind: "quiz-start",
          payload: { quizId, used },
          preview,
          errors,
          toolName: "moodle_quiz_start",
          confirmationCode,
          execute: async () => {
            const r = await client.call<{ attempt: Attempt; warnings?: { message: string }[] }>("mod_quiz_start_attempt", { quizid: quizId });
            if (!r.attempt?.id) throw new MoodleError(`O Moodle não iniciou a tentativa: ${(r.warnings ?? []).map((w) => w.message).join("; ")}`);
            return `✅ Tentativa iniciada (attemptId ${r.attempt.id}, tentativa nº ${r.attempt.attempt}). Use moodle_quiz_questions com attemptId=${r.attempt.id}.`;
          },
        });
      } catch (err) {
        return text(describeError(err), true);
      }
    },
  );

  server.registerTool(
    "moodle_quiz_questions",
    {
      title: "Ver questões",
      description:
        "Mostra as questões de uma tentativa em andamento (texto, opções com letras, imagens e o que já está marcado). " +
        `Em navegação livre traz todas as páginas; em navegação sequencial só a página atual. ${QUIZ_RULE}`,
      inputSchema: {
        attemptId: z.number().int().positive().describe("attemptId (de moodle_quiz_start ou moodle_list_quizzes)"),
        page: z.number().int().min(1).optional().describe("só esta página (1, 2, 3…)"),
      },
      annotations: READ_ONLY,
    },
    async ({ attemptId, page }): Promise<CallToolResult> => {
      try {
        const { client, site } = await getSession();
        const { quiz, attempt } = await locateAttempt(client, site.userid, attemptId);
        if (attempt.state !== "inprogress") {
          return text(`Esta tentativa está ${STATE_PT[attempt.state] ?? attempt.state}. Use moodle_quiz_review para ver a revisão.`, true);
        }
        const current = attempt.currentpage ?? 0;
        const pages = [];
        if (isSequential(quiz)) {
          // Sequencial: abrir outra página avança sem volta. Só a página atual.
          if (page !== undefined && page - 1 !== current) {
            return text(
              `Este questionário tem navegação sequencial: só a página atual (${current + 1}) pode ser vista. ` +
                "Para avançar use moodle_quiz_next_page (não dá para voltar).",
              true,
            );
          }
          pages.push(await getPage(client, attemptId, current));
        } else if (page !== undefined) {
          pages.push(await getPage(client, attemptId, page - 1));
        } else {
          // Navegação livre: ler páginas não muda nada.
          let next = 0;
          while (next !== -1 && pages.length < 100) {
            const p = await getPage(client, attemptId, next);
            pages.push(p);
            next = p.nextpage;
          }
        }
        const questions = pages.flatMap((p) => p.questions).map((q) => questionView(q, parseQuestionHtml(q.html)));
        const unsupported = questions.filter((q) => !q.options && !q.multipleOptions && !q.textFields && !q.lists && !q.essay);
        return text(
          JSON.stringify(
            compact({
              attemptId,
              quiz: quiz.name,
              navigation: isSequential(quiz) ? `sequencial (página ${current + 1}; não dá para voltar)` : "livre",
              timeLeft: timeLeft(quiz, attempt),
              messages: pages[0]?.messages?.map(htmlToText),
              questions,
              note: unsupported.length ? `Questões ${unsupported.map((q) => q.number).join(", ")} têm um tipo que o MCP não lê; responda pelo Moodle.` : null,
              rule: QUIZ_RULE,
            }),
            null,
            2,
          ),
        );
      } catch (err) {
        return text(describeError(err), true);
      }
    },
  );

  server.registerTool(
    "moodle_quiz_next_page",
    {
      title: "Próxima página (navegação sequencial)",
      description: `Só para questionários com navegação sequencial: avança para a próxima página. Não dá para voltar depois. ${CONFIRMATION_RULE}`,
      inputSchema: {
        attemptId: z.number().int().positive(),
        confirmationCode: z.string().optional().describe(CONFIRMATION_CODE_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ attemptId, confirmationCode }): Promise<CallToolResult> => {
      try {
        const { client, site } = await getSession();
        const { quiz, attempt } = await locateAttempt(client, site.userid, attemptId);
        const current = attempt.currentpage ?? 0;
        const errors: string[] = [];
        if (!isSequential(quiz)) errors.push("Este questionário tem navegação livre: use moodle_quiz_questions com page, sem precisar avançar.");
        if (attempt.state !== "inprogress") errors.push(`A tentativa está ${STATE_PT[attempt.state] ?? attempt.state}.`);
        const totalPages = attempt.layout ? attempt.layout.split(",").filter((x) => x === "0").length : null;
        if (totalPages !== null && current + 1 >= totalPages) errors.push("Esta já é a última página. Use moodle_quiz_finish para enviar.");
        const preview = [
          `Questionário: ${quiz.name}`,
          `Página atual: ${current + 1}${totalPages ? ` de ${totalPages}` : ""} → próxima: ${current + 2}`,
          "",
          "Atenção:",
          "  ! Na navegação sequencial NÃO dá para voltar à página atual depois de avançar.",
        ].join("\n");
        return confirmedAction({
          kind: "quiz-next-page",
          payload: { attemptId, current },
          preview,
          errors,
          toolName: "moodle_quiz_next_page",
          confirmationCode,
          execute: async () => {
            await getPage(client, attemptId, current + 1);
            return `✅ Página ${current + 2} aberta. Use moodle_quiz_questions com attemptId=${attemptId}.`;
          },
        });
      } catch (err) {
        return text(describeError(err), true);
      }
    },
  );

  server.registerTool(
    "moodle_quiz_answer",
    {
      title: "Marcar resposta",
      description:
        "Marca na tentativa a resposta que o ALUNO disse para uma questão (ex.: \"marca a letra b na questão 3\"). " +
        "Pode ser trocada depois, até finalizar. Uma opção: answer=\"b\". Várias: answer=[\"a\",\"c\"]. Texto: answer=\"42\". " +
        `Vários campos: answer={"Campo": "valor"}. Para limpar uma escolha: answer="limpar". ${QUIZ_RULE}`,
      inputSchema: {
        attemptId: z.number().int().positive(),
        slot: z.number().int().positive().describe("slot da questão (de moodle_quiz_questions)"),
        answer: z
          .union([z.string(), z.array(z.string()), z.record(z.string(), z.string())])
          .describe("exatamente o que o aluno pediu para marcar"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ attemptId, slot, answer }): Promise<CallToolResult> => {
      try {
        const { client, site } = await getSession();
        const { quiz, attempt } = await locateAttempt(client, site.userid, attemptId);
        if (attempt.state !== "inprogress") return text(`A tentativa está ${STATE_PT[attempt.state] ?? attempt.state}; não dá mais para marcar.`, true);
        const summary = await client.call<{ questions: AttemptQuestion[] }>("mod_quiz_get_attempt_summary", { attemptid: attemptId });
        const sq = summary.questions.find((q) => q.slot === slot);
        if (!sq) return text(`Questão com slot ${slot} não existe nesta tentativa.`, true);
        if (sq.blockedbyprevious) return text("Esta questão está bloqueada até a anterior ser respondida.", true);
        if (isSequential(quiz) && sq.page !== (attempt.currentpage ?? 0)) {
          return text(`Navegação sequencial: só dá para responder questões da página atual (${(attempt.currentpage ?? 0) + 1}).`, true);
        }

        const pageData = await getPage(client, attemptId, sq.page);
        if (pageData.attempt.state !== "inprogress") return text(`A tentativa está ${STATE_PT[pageData.attempt.state] ?? pageData.attempt.state}; não dá mais para marcar.`, true);
        const q = pageData.questions.find((x) => x.slot === slot)!;
        const parsed = parseQuestionHtml(q.html);
        const { data, summary: chosen } = buildAnswerData(parsed, slot, answer);

        const r = await client.call<{ state: string; warnings?: { message: string }[] }>("mod_quiz_process_attempt", {
          attemptid: attemptId,
          data,
          finishattempt: false,
          timeup: false,
        });
        if (r.warnings?.length) throw new MoodleError(r.warnings.map((w) => w.message).join("; "));

        // Confere o que ficou gravado.
        const after = await getPage(client, attemptId, sq.page);
        const saved = currentAnswer(parseQuestionHtml(after.questions.find((x) => x.slot === slot)!.html));
        return text(`✅ Questão ${q.number ?? parsed.number ?? slot}: marcado ${chosen}.\nNo Moodle agora: ${saved ?? "(sem resposta)"}.`);
      } catch (err) {
        if (err instanceof AnswerError) return text(err.message, true);
        return text(describeError(err), true);
      }
    },
  );

  server.registerTool(
    "moodle_quiz_finish",
    {
      title: "Enviar questionário",
      description: `Envia (finaliza) a tentativa para correção. Depois disso não dá para mudar respostas. ${CONFIRMATION_RULE}`,
      inputSchema: {
        attemptId: z.number().int().positive(),
        confirmationCode: z.string().optional().describe(CONFIRMATION_CODE_DESC),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ attemptId, confirmationCode }): Promise<CallToolResult> => {
      try {
        const { client } = await getSession();
        const s = await client.call<{ questions: AttemptQuestion[] }>("mod_quiz_get_attempt_summary", { attemptid: attemptId });
        const unanswered = s.questions.filter((q) => /não respondid|not yet answered|incomplet/i.test(q.status ?? ""));
        const preview = [
          `Tentativa ${attemptId}: ${s.questions.length} questões.`,
          ...s.questions.map((q) => `  ${q.number ?? q.slot}. ${q.status ?? "?"}`),
          "",
          "Atenção:",
          "  ! Depois de enviar, as respostas não podem mais ser alteradas.",
          ...(unanswered.length ? [`  ! ${unanswered.length} questão(ões) sem resposta: ${unanswered.map((q) => q.number ?? q.slot).join(", ")}.`] : []),
        ].join("\n");
        return confirmedAction({
          kind: "quiz-finish",
          payload: { attemptId, status: s.questions.map((q) => [q.slot, q.status]) },
          preview,
          errors: [],
          toolName: "moodle_quiz_finish",
          confirmationCode,
          execute: async () => {
            const r = await client.call<{ state: string; warnings?: { message: string }[] }>("mod_quiz_process_attempt", {
              attemptid: attemptId,
              data: [],
              finishattempt: true,
              timeup: false,
            });
            if (r.state !== "finished") {
              throw new MoodleError(`O Moodle não finalizou (estado: ${r.state}). ${(r.warnings ?? []).map((w) => w.message).join("; ")}`);
            }
            return "✅ Questionário enviado. Use moodle_list_quizzes para ver a nota (quando o professor liberar) e moodle_quiz_review para a revisão, se permitida.";
          },
        });
      } catch (err) {
        return text(describeError(err), true);
      }
    },
  );

  server.registerTool(
    "moodle_quiz_review",
    {
      title: "Revisar tentativa",
      description:
        "Mostra a revisão de uma tentativa já finalizada: questões, o que o aluno marcou, se acertou, nota e feedback — só o que o professor liberou.",
      inputSchema: { attemptId: z.number().int().positive() },
      annotations: READ_ONLY,
    },
    ({ attemptId }) =>
      runTool(async ({ client }) => {
        try {
          const r = await client.call<{ grade: string; attempt: Attempt; questions: AttemptQuestion[] }>("mod_quiz_get_attempt_review", {
            attemptid: attemptId,
            page: -1,
          });
          return compact({
            grade: r.grade && r.grade !== "notyetgraded" ? r.grade : null,
            state: STATE_PT[r.attempt.state] ?? r.attempt.state,
            questions: r.questions.map((q) => {
              const p = parseQuestionHtml(q.html);
              return compact({
                number: q.number ?? p.number,
                text: p.text,
                yourAnswer: currentAnswer(p),
                result: p.review?.state ?? q.state,
                mark: q.mark ? `${q.mark} de ${q.maxmark}` : p.review?.mark,
                feedback: p.review?.feedback,
                rightAnswer: p.review?.rightAnswer,
              });
            }),
          });
        } catch (err) {
          if (err instanceof MoodleError && err.errorcode === "noreview") {
            return { review: "O professor não liberou a revisão desta tentativa (ou ainda não liberou)." };
          }
          throw err;
        }
      }),
  );
}
