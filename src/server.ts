import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerCourseTools } from "./tools/courses.js";
import { registerFileTools } from "./tools/files.js";
import { registerGradeTools } from "./tools/grades.js";
import { registerSubmitTools } from "./tools/submit.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "unisinos-moodle", version: "0.1.0" },
    {
      instructions:
        "Ferramentas para o Moodle da Unisinos (www.moodle.unisinos.br) em nome do aluno logado. " +
        "Comece por moodle_list_courses para obter os ids das disciplinas. " +
        "Datas estão no fuso de São Paulo. Para ler materiais (PDF, slides etc.) use moodle_read_file com o fileurl; para salvar no computador, moodle_download_file. As únicas ferramentas que alteram o Moodle são moodle_submit_assignment e moodle_remove_submission, e ambas exigem uma prévia confirmada explicitamente pelo aluno.",
    },
  );
  registerCourseTools(server);
  registerCalendarTools(server);
  registerGradeTools(server);
  registerAssignmentTools(server);
  registerFileTools(server);
  registerSubmitTools(server);
  return server;
}

