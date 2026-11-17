import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MoodleError, type MoodleClient } from "../moodle/client.js";
import { compact, formatDate, htmlToText, nowUnix, shortCourseName, shortenCourseNamesIn } from "../moodle/format.js";
import { TIMEZONE } from "../config.js";
import { getEnrolledCourses } from "./courses.js";
import { READ_ONLY, runTool } from "./helpers.js";

interface Module {
  id: number;
  name: string;
  modname: string;
  instance?: number;
  url?: string;
  uservisible?: boolean;
}

interface Instance {
  contextlevel: string;
  id: number;
  updates: { name: string; timeupdated?: number; itemids?: number[] }[];
}

const UPDATE_PT: Record<string, string> = {
  configuration: "descrição ou configuração alterada",
  contentfiles: "arquivos novos ou alterados",
  introfiles: "anexos do enunciado alterados",
  submissions: "envio novo ou alterado",
  grades: "nota nova ou alterada",
  gradeitems: "item de avaliação alterado",
  outcomes: "resultados de aprendizagem",
  comments: "comentários novos",
  ratings: "avaliações novas",
  discussions: "tópicos novos ou atualizados",
  completion: "conclusão alterada",
  answers: "respostas novas",
  entries: "entradas novas",
  usersubmissions: "envios novos",
  attempts: "tentativas",
  tags: "tags",
};

/** Atividades do curso, por cmid (e por tipo+instância, para o calendário). */
async function courseModules(client: MoodleClient, courseid: number): Promise<Module[]> {
  const sections = await client.call<{ modules: Module[] }[]>("core_course_get_contents", {
    courseid,
    options: [{ name: "excludecontents", value: true }],
  });
  return sections.flatMap((s) => s.modules).filter((m) => m.uservisible !== false && m.modname !== "label");
}

/**
 * core_course_check_updates em lotes. Se um lote falhar (o Moodle da Unisinos dá erro de banco
 * para alguns tipos de atividade), divide ao meio até isolar e pular as atividades problemáticas.
 */
async function checkUpdates(
  client: MoodleClient,
  courseid: number,
  mods: Module[],
  since: number,
  skipped: Module[],
): Promise<Instance[]> {
  if (!mods.length) return [];
  try {
    const r = await client.call<{ instances: Instance[] }>("core_course_check_updates", {
      courseid,
      tocheck: mods.map((m) => ({ contextlevel: "module", id: m.id, since })),
    });
    return r.instances;
  } catch (err) {
    if (!(err instanceof MoodleError) || err.isAuthError) throw err;
    if (mods.length === 1) {
      skipped.push(mods[0]!);
      return [];
    }
    const half = Math.ceil(mods.length / 2);
    return [
      ...(await checkUpdates(client, courseid, mods.slice(0, half), since, skipped)),
      ...(await checkUpdates(client, courseid, mods.slice(half), since, skipped)),
    ];
  }
}

/** Tipos que sabidamente quebram a API de novidades no Moodle da Unisinos. */
const KNOWN_BROKEN = new Set(["quiz"]);
const BATCH = 40;

function dayLabel(unix: number): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, weekday: "short", day: "2-digit", month: "2-digit" })
    .format(new Date(unix * 1000))
    .replace(".", "");
}

function hourLabel(unix: number): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" }).format(new Date(unix * 1000));
}

interface CalendarEvent {
  id: number;
  name: string;
  description?: string;
  courseid: number;
  groupid?: number;
  modulename?: string;
  instance?: number;
  eventtype: string;
  timestart: number;
  timeduration?: number;
  location?: string;
}

const EVENT_TYPES: Record<string, string> = {
  due: "prazo de entrega",
  close: "fecha",
  open: "abre",
  expectcompletionon: "concluir até",
  gradingdue: "prazo de correção",
  course: "evento da disciplina",
  group: "evento do grupo",
  user: "evento pessoal",
  site: "evento da instituição",
  category: "evento da categoria",
};

interface Notification {
  subject: string;
  smallmessage?: string;
  fullmessage?: string;
  timecreated: number;
  component?: string;
  eventtype?: string;
}

export function registerUpdateTools(server: McpServer): void {
  server.registerTool(
    "moodle_whats_new",
    {
      title: "Novidades nas disciplinas",
      description:
        "Mostra o que mudou nas disciplinas desde um momento: materiais novos ou alterados, enunciados, notas, envios, fóruns etc. " +
        "Use para \"o que mudou desde ontem?\" ou \"tem coisa nova em Álgebra?\". Mudanças em questionários aparecem pelas notificações do Moodle.",
      inputSchema: {
        days: z.number().min(0.04).max(90).default(1).describe("olhar quantos dias para trás (padrão 1; 0.5 = 12 h)"),
        courseids: z.array(z.number().int().positive()).optional().describe("limitar a estas disciplinas (padrão: todas)"),
      },
      annotations: READ_ONLY,
    },
    ({ days, courseids }) =>
      runTool(async ({ client, site }) => {
        const since = Math.floor(nowUnix() - days * 86_400);
        const all = await getEnrolledCourses(client, site.userid);
        const courses = courseids ? all.filter((c) => courseids.includes(c.id)) : all;

        const byCourse = [];
        const skippedAll: string[] = [];
        for (const course of courses) {
          const mods = await courseModules(client, course.id);
          const checkable = mods.filter((m) => !KNOWN_BROKEN.has(m.modname));
          const skipped: Module[] = [];
          const instances: Instance[] = [];
          for (let i = 0; i < checkable.length; i += BATCH) {
            instances.push(...(await checkUpdates(client, course.id, checkable.slice(i, i + BATCH), since, skipped)));
          }
          const byId = new Map(mods.map((m) => [m.id, m]));
          const changes = instances
            .filter((i) => i.contextlevel === "module" && i.updates.length)
            .map((i) => {
              const m = byId.get(i.id);
              return compact({
                activity: m?.name ?? `atividade ${i.id}`,
                type: m?.modname,
                cmid: i.id,
                what: [...new Set(i.updates.map((u) => UPDATE_PT[u.name] ?? u.name))],
                url: m?.url,
              });
            });
          skippedAll.push(...skipped.map((m) => `${m.name} (${shortCourseName(course.fullname)})`));
          // Só "configuração alterada" costuma ser ajuste em massa do professor: resume para não esconder o que importa.
          const CONFIG = UPDATE_PT.configuration!;
          const content = changes.filter((c) => c.what!.some((w) => w !== CONFIG));
          const configOnly = changes.filter((c) => c.what!.every((w) => w === CONFIG));
          const SUMMARIZE_FROM = 6;
          if (content.length || configOnly.length) {
            byCourse.push(
              compact({
                course: shortCourseName(course.fullname),
                courseid: course.id,
                changes: configOnly.length < SUMMARIZE_FROM ? [...content, ...configOnly] : content,
                alsoChangedSettings:
                  configOnly.length >= SUMMARIZE_FROM
                    ? `${configOnly.length} atividades tiveram só a descrição ou configuração alterada (provável ajuste em massa), ex.: ` +
                      [...new Set(configOnly.map((c) => c.activity))].slice(0, 5).join("; ")
                    : null,
              }),
            );
          }
        }

        // Notificações de conteúdo do mesmo período (cobrem questionários)
        const n = await client.call<{ notifications: Notification[] }>("message_popup_get_popup_notifications", {
          useridto: site.userid,
          newestfirst: true,
          limit: 50,
          offset: 0,
        });
        const fullnames = all.map((c) => c.fullname);
        const notices = n.notifications
          .filter((x) => x.timecreated >= since && (x.component === "moodle" || x.component?.startsWith("mod_")))
          .map((x) =>
            compact({
              when: formatDate(x.timecreated),
              text: shortenCourseNamesIn(htmlToText(x.smallmessage || x.subject, 300), fullnames)
                .replace(/\s*\.?\s*(Change your notification preferences|Alterar suas preferências de notificação).*$/is, "")
                .replace(/\s+([.,;:])/g, "$1"),
            }),
          );

        return compact({
          since: formatDate(since),
          courses: byCourse.length ? byCourse : null,
          nothingNew: byCourse.length || notices.length ? null : "Nenhuma novidade nas disciplinas neste período.",
          notifications: notices,
          note:
            "Questionários não entram na verificação de atividades (o Moodle da Unisinos devolve erro para eles); mudanças neles aparecem nas notificações." +
            (skippedAll.length ? ` Também não foi possível verificar: ${skippedAll.join("; ")}.` : ""),
        });
      }),
  );

  server.registerTool(
    "moodle_calendar",
    {
      title: "Calendário",
      description:
        "Agenda do Moodle num período: prazos de entrega, abertura e fechamento de questionários, eventos das disciplinas, " +
        "do grupo, pessoais e da instituição. Aceita olhar para trás (pastDays).",
      inputSchema: {
        days: z.number().int().min(1).max(180).default(14).describe("dias à frente (padrão 14)"),
        pastDays: z.number().int().min(0).max(180).default(0).describe("dias para trás (padrão 0)"),
        courseids: z.array(z.number().int().positive()).optional().describe("limitar a estas disciplinas (padrão: todas)"),
      },
      annotations: READ_ONLY,
    },
    ({ days, pastDays, courseids }) =>
      runTool(async ({ client, site }) => {
        const now = nowUnix();
        const all = await getEnrolledCourses(client, site.userid);
        const courses = courseids ? all.filter((c) => courseids.includes(c.id)) : all;
        const r = await client.call<{ events: CalendarEvent[] }>("core_calendar_get_calendar_events", {
          events: { courseids: courses.map((c) => c.id) },
          options: { userevents: true, siteevents: true, timestart: now - pastDays * 86_400, timeend: now + days * 86_400 },
        });
        const names = new Map(all.map((c) => [c.id, shortCourseName(c.fullname)]));

        // Link da atividade: precisa do cmid, que vem do conteúdo da disciplina.
        const cmByInstance = new Map<string, Module>();
        for (const cid of new Set(r.events.filter((e) => e.modulename).map((e) => e.courseid))) {
          for (const m of await courseModules(client, cid)) cmByInstance.set(`${m.modname}:${m.instance}`, m);
        }

        return r.events
          .filter((e) => !courseids || courseids.includes(e.courseid) || !e.courseid || e.courseid === 1)
          .sort((a, b) => a.timestart - b.timestart)
          .map((e) => {
            const m = e.modulename ? cmByInstance.get(`${e.modulename}:${e.instance}`) : undefined;
            const end = e.timeduration ? e.timestart + e.timeduration : null;
            return compact({
              day: dayLabel(e.timestart),
              time: hourLabel(e.timestart) + (end ? `–${dayLabel(end) === dayLabel(e.timestart) ? hourLabel(end) : formatDate(end)}` : ""),
              past: e.timestart < now ? true : null,
              event: e.name,
              type: EVENT_TYPES[e.eventtype] ?? e.eventtype,
              activity: e.modulename,
              course: e.courseid && e.courseid !== 1 ? names.get(e.courseid) : null,
              location: e.location || null,
              description: e.modulename ? null : htmlToText(e.description, 300) || null,
              url: m?.url,
            });
          });
      }),
  );
}
