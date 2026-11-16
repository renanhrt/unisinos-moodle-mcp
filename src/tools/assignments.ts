import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, formatBytes, formatDate, htmlToText, nowUnix, shortCourseName } from "../moodle/format.js";
import { READ_ONLY, runTool } from "./helpers.js";

interface Assignment {
  id: number;
  cmid: number;
  course: number;
  name: string;
  intro?: string;
  duedate?: number;
  cutoffdate?: number;
  allowsubmissionsfromdate?: number;
  gradingduedate?: number;
  nosubmissions?: number;
  teamsubmission?: number;
  maxattempts?: number;
  introattachments?: { filename: string; fileurl: string; filesize?: number }[];
}

interface AssignmentsResponse {
  courses: { id: number; fullname: string; assignments: Assignment[] }[];
}

interface PluginFile {
  filename?: string;
  filepath?: string;
  filesize?: number;
  fileurl?: string;
  mimetype?: string;
}

interface SubmissionPlugin {
  type: string;
  name: string;
  fileareas?: { area: string; files?: PluginFile[] }[];
  editorfields?: { name: string; description?: string; text: string }[];
}

interface Submission {
  status: string;
  timemodified?: number;
  attemptnumber?: number;
  plugins?: SubmissionPlugin[];
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
    timelimit?: number;
    gradingstatus?: string;
  };
  feedback?: {
    gradefordisplay?: string;
    gradeddate?: number;
    plugins?: SubmissionPlugin[];
  };
  assignmentdata?: { activity?: string };
}

const SUBMISSION_STATUS: Record<string, string> = {
  new: "nada enviado",
  draft: "rascunho (não enviado para avaliação)",
  submitted: "enviado para avaliação",
  reopened: "reaberto",
};

const GRADING_STATUS: Record<string, string> = {
  notgraded: "não avaliado",
  graded: "avaliado",
  released: "nota liberada",
  notmarked: "não avaliado",
  inmarking: "em correção",
  readyforreview: "pronto para revisão",
  inreview: "em revisão",
  readyforrelease: "pronto para liberar",
};

function pluginFiles(plugins: SubmissionPlugin[] | undefined) {
  return (plugins ?? []).flatMap((p) =>
    (p.fileareas ?? []).flatMap((a) =>
      (a.files ?? [])
        .filter((f) => f.filename && f.filename !== ".")
        .map((f) => compact({ filename: f.filename, size: formatBytes(f.filesize), fileurl: f.fileurl })),
    ),
  );
}

function pluginText(plugins: SubmissionPlugin[] | undefined, max = 3000): string | null {
  const text = (plugins ?? [])
    .flatMap((p) => (p.editorfields ?? []).map((e) => htmlToText(e.text)))
    .filter(Boolean)
    .join("\n\n");
  return text ? (text.length > max ? text.slice(0, max - 1) + "…" : text) : null;
}

export function registerAssignmentTools(server: McpServer): void {
  server.registerTool(
    "moodle_list_assignments",
    {
      title: "Listar tarefas",
      description:
        "Lista as tarefas (mod_assign) das disciplinas com datas de abertura, entrega e corte. " +
        "Para saber se o aluno já entregou, use moodle_get_assignment_status com o assignmentId.",
      inputSchema: {
        courseids: z
          .array(z.number().int().positive())
          .optional()
          .describe("limitar a estas disciplinas (padrão: todas as do aluno)"),
        onlyOpen: z.boolean().default(false).describe("mostrar só tarefas cujo prazo ainda não passou"),
        includeDescriptions: z.boolean().default(false).describe("incluir o enunciado da tarefa"),
      },
      annotations: READ_ONLY,
    },
    ({ courseids, onlyOpen, includeDescriptions }) =>
      runTool(async ({ client }) => {
        const data = await client.call<AssignmentsResponse>("mod_assign_get_assignments", {
          courseids: courseids ?? [],
        });
        const now = nowUnix();
        return data.courses
          .map((c) => ({
            courseid: c.id,
            course: shortCourseName(c.fullname),
            assignments: c.assignments
              .filter((a) => !onlyOpen || !a.duedate || (a.cutoffdate || a.duedate) > now)
              .sort((a, b) => (a.duedate || Infinity) - (b.duedate || Infinity))
              .map((a) =>
                compact({
                  assignmentId: a.id,
                  cmid: a.cmid,
                  name: a.name,
                  opens: formatDate(a.allowsubmissionsfromdate),
                  due: formatDate(a.duedate),
                  cutoff: formatDate(a.cutoffdate),
                  overdue: a.duedate && a.duedate < now ? true : null,
                  offline: a.nosubmissions ? "entrega fora do Moodle" : null,
                  group: a.teamsubmission ? true : null,
                  description: includeDescriptions ? htmlToText(a.intro, 3000) : null,
                  attachments: a.introattachments?.map((f) => ({ filename: f.filename, fileurl: f.fileurl })),
                }),
              ),
          }))
          .filter((c) => c.assignments.length > 0);
      }),
  );

  server.registerTool(
    "moodle_get_assignment_status",
    {
      title: "Status de uma tarefa",
      description:
        "Mostra a situação do aluno em uma tarefa: se já enviou, arquivos/texto enviados, se ainda pode editar, " +
        "status da correção, nota e comentários do professor.",
      inputSchema: {
        assignmentId: z.number().int().positive().describe("assignmentId (de moodle_list_assignments ou instanceId de moodle_upcoming_deadlines)"),
      },
      annotations: READ_ONLY,
    },
    ({ assignmentId }) =>
      runTool(async ({ client }) => {
        const s = await client.call<SubmissionStatus>("mod_assign_get_submission_status", { assignid: assignmentId });
        const attempt = s.lastattempt;
        const sub = attempt?.teamsubmission ?? attempt?.submission;
        return compact({
          submission: sub ? SUBMISSION_STATUS[sub.status] ?? sub.status : "sem envio",
          lastModified: formatDate(sub?.timemodified),
          attempt: sub?.attemptnumber !== undefined ? sub.attemptnumber + 1 : null,
          canSubmit: attempt?.cansubmit,
          canEdit: attempt?.canedit,
          locked: attempt?.locked || null,
          extensionUntil: formatDate(attempt?.extensionduedate),
          grading: attempt?.gradingstatus ? GRADING_STATUS[attempt.gradingstatus] ?? attempt.gradingstatus : null,
          submittedFiles: pluginFiles(sub?.plugins),
          submittedText: pluginText(sub?.plugins),
          grade: s.feedback?.gradefordisplay ? htmlToText(s.feedback.gradefordisplay) : null,
          gradedAt: formatDate(s.feedback?.gradeddate),
          teacherComments: pluginText(s.feedback?.plugins),
          feedbackFiles: pluginFiles(s.feedback?.plugins),
        });
      }),
  );
}
