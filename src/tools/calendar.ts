import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MoodleError, type MoodleClient } from "../moodle/client.js";
import { compact, formatDate, nowUnix, shortCourseName } from "../moodle/format.js";
import { READ_ONLY, runTool } from "./helpers.js";

interface ActionEvent {
  id: number;
  name: string;
  activityname?: string;
  modulename?: string;
  instance?: number;
  eventtype?: string;
  timesort: number;
  overdue?: boolean;
  url?: string;
  course?: { id: number; fullname: string };
  action?: { name: string; url?: string; actionable?: boolean; itemcount?: number };
}

const DAY = 86_400;

/**
 * Nos eventos da linha do tempo, `instance` é o cmid (id da página da atividade), e não o id que
 * as ferramentas de tarefa e de questionário pedem. Aqui traduzimos cmid → assignmentId / quizId.
 * Se essa consulta falhar, os prazos ainda são listados, só sem o id.
 */
async function activityIds(client: MoodleClient, events: ActionEvent[]) {
  const coursesWith = (type: string) => [
    ...new Set(events.filter((e) => e.modulename === type && e.course).map((e) => e.course!.id)),
  ];
  const optional = async <T>(courseids: number[], wsfunction: string, empty: T): Promise<T> => {
    if (!courseids.length) return empty;
    try {
      return await client.call<T>(wsfunction, { courseids });
    } catch (err) {
      if (err instanceof MoodleError && !err.isAuthError) return empty;
      throw err;
    }
  };
  const [a, q] = await Promise.all([
    optional<{ courses: { assignments: { id: number; cmid: number }[] }[] }>(coursesWith("assign"), "mod_assign_get_assignments", { courses: [] }),
    optional<{ quizzes: { id: number; coursemodule: number }[] }>(coursesWith("quiz"), "mod_quiz_get_quizzes_by_courses", { quizzes: [] }),
  ]);
  return {
    assignments: new Map(a.courses.flatMap((c) => c.assignments).map((x) => [x.cmid, x.id])),
    quizzes: new Map(q.quizzes.map((x) => [x.coursemodule, x.id])),
  };
}

export function registerCalendarTools(server: McpServer): void {
  server.registerTool(
    "moodle_upcoming_deadlines",
    {
      title: "Próximos prazos",
      description:
        "Lista as atividades com prazo (tarefas, questionários, fóruns avaliados etc.) que ainda pedem alguma ação do aluno, " +
        "do linha do tempo do Moodle. Inclui itens atrasados recentes.",
      inputSchema: {
        days: z.number().int().min(1).max(180).default(14).describe("quantos dias à frente olhar (padrão 14)"),
        overdueDays: z
          .number()
          .int()
          .min(0)
          .max(90)
          .default(7)
          .describe("quantos dias para trás incluir itens atrasados (padrão 7; 0 = nenhum)"),
        courseid: z.number().int().positive().optional().describe("limitar a uma disciplina"),
      },
      annotations: READ_ONLY,
    },
    ({ days, overdueDays, courseid }) =>
      runTool(async ({ client }) => {
        const now = nowUnix();
        const range = { timesortfrom: now - overdueDays * DAY, timesortto: now + days * DAY };
        const { events } = courseid
          ? await client.call<{ events: ActionEvent[] }>("core_calendar_get_action_events_by_course", {
              courseid,
              ...range,
            })
          : await client.call<{ events: ActionEvent[] }>("core_calendar_get_action_events_by_timesort", {
              ...range,
              limitnum: 50,
              limittononsuspendedevents: true,
            });

        const { assignments, quizzes } = await activityIds(client, events);

        return events
          .sort((a, b) => a.timesort - b.timesort)
          .map((e) =>
            compact({
              when: formatDate(e.timesort),
              overdue: e.overdue || e.timesort < now || null,
              activity: e.activityname ?? e.name,
              event: e.name,
              type: e.modulename,
              cmid: e.instance,
              assignmentId: e.modulename === "assign" ? assignments.get(e.instance ?? 0) : null,
              quizId: e.modulename === "quiz" ? quizzes.get(e.instance ?? 0) : null,
              course: shortCourseName(e.course?.fullname),
              courseid: e.course?.id,
              todo: e.action?.actionable ? e.action.name : null,
              url: e.action?.url ?? e.url,
            }),
          );
      }),
  );
}
