import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { MoodleClient } from "../moodle/client.js";
import {
  compact,
  formatBytes,
  formatDate,
  htmlToText,
  nowUnix,
  parseUnisinosCourseName,
} from "../moodle/format.js";
import { READ_ONLY, runTool } from "./helpers.js";

export interface EnrolledCourse {
  id: number;
  shortname: string;
  fullname: string;
  displayname?: string;
  summary?: string;
  category?: number;
  progress?: number | null;
  completed?: boolean;
  startdate?: number;
  enddate?: number;
  lastaccess?: number | null;
  isfavourite?: boolean;
  hidden?: boolean;
  visible?: number;
}

export type CourseFilter = "inprogress" | "past" | "future" | "all";

export function classifyCourse(c: EnrolledCourse, now = nowUnix()): Exclude<CourseFilter, "all"> {
  if (c.startdate && c.startdate > now) return "future";
  if (c.enddate && c.enddate < now) return "past";
  return "inprogress";
}

export async function getEnrolledCourses(client: MoodleClient, userid: number): Promise<EnrolledCourse[]> {
  return client.call<EnrolledCourse[]>("core_enrol_get_users_courses", { userid, returnusercount: false });
}

interface CourseModule {
  id: number;
  name: string;
  modname: string;
  instance?: number;
  url?: string;
  description?: string;
  uservisible?: boolean;
  availabilityinfo?: string;
  completiondata?: { state: number; timecompleted?: number };
  dates?: { label: string; timestamp: number }[];
  contents?: {
    type: string;
    filename: string;
    filesize?: number;
    fileurl?: string;
    mimetype?: string;
    timemodified?: number;
  }[];
}

interface CourseSection {
  id: number;
  name: string;
  section?: number;
  summary?: string;
  uservisible?: boolean;
  modules: CourseModule[];
}

const COMPLETION_STATE: Record<number, string> = {
  0: "não concluída",
  1: "concluída",
  2: "concluída (aprovado)",
  3: "concluída (reprovado)",
};

export function registerCourseTools(server: McpServer): void {
  server.registerTool(
    "moodle_get_me",
    {
      title: "Meu perfil no Moodle",
      description: "Mostra quem está logado no Moodle da Unisinos (nome, usuário, id) e a versão do site.",
      annotations: READ_ONLY,
    },
    () =>
      runTool(async ({ site }) => ({
        fullname: site.fullname,
        username: site.username,
        userid: site.userid,
        site: site.sitename,
        siteurl: site.siteurl,
        moodle: site.release,
      })),
  );

  server.registerTool(
    "moodle_list_courses",
    {
      title: "Listar disciplinas",
      description:
        "Lista as disciplinas (cursos) em que o aluno está matriculado no Moodle da Unisinos, com progresso e datas. " +
        "Use o id retornado nas outras ferramentas.",
      inputSchema: {
        filter: z
          .enum(["inprogress", "past", "future", "all"])
          .default("inprogress")
          .describe("inprogress = semestre atual (padrão), past = encerradas, future = ainda não começaram, all = todas"),
      },
      annotations: READ_ONLY,
    },
    ({ filter }) =>
      runTool(async ({ client, site }) => {
        const now = nowUnix();
        const courses = (await getEnrolledCourses(client, site.userid))
          .filter((c) => filter === "all" || classifyCourse(c, now) === filter)
          .sort((a, b) => (b.lastaccess ?? 0) - (a.lastaccess ?? 0));
        return courses.map((c) => {
          const parsed = parseUnisinosCourseName(c.fullname);
          return compact({
            id: c.id,
            name: parsed?.name ?? c.fullname,
            teacher: parsed?.teacher,
            schedule: parsed?.schedule,
            group: parsed?.group,
            semester: parsed?.semester,
            code: parsed?.code,
            campus: parsed?.campus,
            status: classifyCourse(c, now),
            progress: typeof c.progress === "number" ? `${Math.round(c.progress)}%` : null,
            start: formatDate(c.startdate),
            end: formatDate(c.enddate),
            lastAccess: formatDate(c.lastaccess),
            favourite: c.isfavourite || null,
          });
        });
      }),
  );

  server.registerTool(
    "moodle_get_course_contents",
    {
      title: "Conteúdo de uma disciplina",
      description:
        "Mostra as seções/semanas de uma disciplina com suas atividades e materiais (arquivos, links, tarefas, fóruns, questionários), " +
        "incluindo datas e status de conclusão.",
      inputSchema: {
        courseid: z.number().int().positive().describe("id da disciplina (de moodle_list_courses)"),
        includeDescriptions: z
          .boolean()
          .default(false)
          .describe("incluir o texto de descrição das atividades e seções (deixa a resposta maior)"),
      },
      annotations: READ_ONLY,
    },
    ({ courseid, includeDescriptions }) =>
      runTool(async ({ client }) => {
        const sections = await client.call<CourseSection[]>("core_course_get_contents", { courseid });
        const descLimit = includeDescriptions ? 1500 : 0;
        return sections
          .filter((s) => s.uservisible !== false)
          .map((s) =>
            compact({
              section: s.name,
              summary: descLimit ? htmlToText(s.summary, descLimit) : null,
              items: s.modules.map((m) =>
                compact({
                  cmid: m.id,
                  type: m.modname,
                  name: m.modname === "label" ? htmlToText(m.description || m.name, 300) : m.name,
                  instanceId: m.instance,
                  url: m.url,
                  available: m.uservisible === false ? false : null,
                  restriction: m.availabilityinfo ? htmlToText(m.availabilityinfo, 300) : null,
                  completion: m.completiondata ? COMPLETION_STATE[m.completiondata.state] ?? null : null,
                  dates: m.dates?.map((d) => `${d.label} ${formatDate(d.timestamp)}`),
                  description: descLimit && m.modname !== "label" ? htmlToText(m.description, descLimit) : null,
                  files: m.contents
                    ?.filter((f) => f.type === "file")
                    .map((f) =>
                      compact({
                        filename: f.filename,
                        size: formatBytes(f.filesize),
                        mimetype: f.mimetype,
                        modified: formatDate(f.timemodified),
                        fileurl: f.fileurl,
                      }),
                    ),
                  link: m.modname === "url" ? m.contents?.find((f) => f.type === "url")?.fileurl : null,
                }),
              ),
            }),
          );
      }),
  );
}
