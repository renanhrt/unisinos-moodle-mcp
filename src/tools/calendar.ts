import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, formatDate, nowUnix } from "../moodle/format.js";
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

        return events
          .sort((a, b) => a.timesort - b.timesort)
          .map((e) =>
            compact({
              when: formatDate(e.timesort),
              overdue: e.overdue || e.timesort < now || null,
              activity: e.activityname ?? e.name,
              event: e.name,
              type: e.modulename,
              instanceId: e.instance,
              course: e.course?.fullname,
              courseid: e.course?.id,
              todo: e.action?.actionable ? e.action.name : null,
              url: e.action?.url ?? e.url,
            }),
          );
      }),
  );
}
