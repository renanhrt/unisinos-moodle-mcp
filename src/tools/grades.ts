import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compact, formatDate, htmlToText } from "../moodle/format.js";
import { getEnrolledCourses } from "./courses.js";
import { READ_ONLY, runTool } from "./helpers.js";

interface GradeItem {
  id: number;
  itemname: string | null;
  itemtype: string;
  itemmodule?: string | null;
  cmid?: number;
  weightformatted?: string;
  gradeformatted?: string;
  rangeformatted?: string;
  percentageformatted?: string;
  feedback?: string;
  gradedategraded?: number | null;
  gradeishidden?: boolean;
}

interface UserGrades {
  usergrades: { courseid: number; courseidnumber?: string; gradeitems: GradeItem[] }[];
}

/** O Moodle usa "-" para "sem nota". */
function clean(v: string | undefined): string | null {
  if (!v) return null;
  const t = htmlToText(v);
  return t === "-" || t === "" ? null : t;
}

export function registerGradeTools(server: McpServer): void {
  server.registerTool(
    "moodle_get_grades",
    {
      title: "Notas de uma disciplina",
      description:
        "Mostra o boletim de uma disciplina: cada item avaliado com nota, faixa, porcentagem, peso e comentário do professor, além do total.",
      inputSchema: {
        courseid: z.number().int().positive().describe("id da disciplina (de moodle_list_courses)"),
      },
      annotations: READ_ONLY,
    },
    ({ courseid }) =>
      runTool(async ({ client, site }) => {
        const data = await client.call<UserGrades>("gradereport_user_get_grade_items", {
          courseid,
          userid: site.userid,
        });
        const items = data.usergrades[0]?.gradeitems ?? [];
        return items.map((g) =>
          compact({
            item:
              g.itemtype === "course"
                ? "TOTAL DA DISCIPLINA"
                : g.itemtype === "category"
                  ? `Categoria: ${g.itemname ?? ""}`
                  : g.itemname,
            type: g.itemmodule,
            cmid: g.cmid,
            grade: g.gradeishidden ? "oculta" : clean(g.gradeformatted),
            range: clean(g.rangeformatted),
            percentage: clean(g.percentageformatted),
            weight: clean(g.weightformatted),
            feedback: g.feedback ? htmlToText(g.feedback, 2000) : null,
            gradedAt: formatDate(g.gradedategraded),
          }),
        );
      }),
  );

  server.registerTool(
    "moodle_grades_overview",
    {
      title: "Resumo de notas",
      description: "Mostra a nota total atual de todas as disciplinas do aluno de uma vez.",
      annotations: READ_ONLY,
    },
    () =>
      runTool(async ({ client, site }) => {
        const [overview, courses] = await Promise.all([
          client.call<{ grades: { courseid: number; grade: string; rawgrade: string | null }[] }>(
            "gradereport_overview_get_course_grades",
            { userid: site.userid },
          ),
          getEnrolledCourses(client, site.userid),
        ]);
        const names = new Map(courses.map((c) => [c.id, c.fullname]));
        return overview.grades.map((g) =>
          compact({ courseid: g.courseid, course: names.get(g.courseid), grade: clean(g.grade) ?? "sem nota" }),
        );
      }),
  );
}
