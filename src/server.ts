import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerCourseTools } from "./tools/courses.js";
import { registerGradeTools } from "./tools/grades.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "unisinos-moodle", version: "0.1.0" },
    {
      instructions:
        "Ferramentas para o Moodle da Unisinos (www.moodle.unisinos.br) em nome do aluno logado. " +
        "Comece por moodle_list_courses para obter os ids das disciplinas. " +
        "Datas estão no fuso de São Paulo. Todas as ferramentas atuais são somente leitura.",
    },
  );
  registerCourseTools(server);
  registerCalendarTools(server);
  registerGradeTools(server);
  registerAssignmentTools(server);
  return server;
}

