import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAssignmentTools } from "./tools/assignments.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerCourseTools } from "./tools/courses.js";
import { registerFileTools } from "./tools/files.js";
import { registerForumTools } from "./tools/forums.js";
import { registerGradeTools } from "./tools/grades.js";
import { registerMessageTools } from "./tools/messages.js";
import { QUIZ_RULE, registerQuizTools } from "./tools/quiz.js";
import { registerSubmitTools } from "./tools/submit.js";
import { registerUpdateTools } from "./tools/updates.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "unisinos-moodle", version: "0.7.0" },
    {
      instructions:
        "Ferramentas para o Moodle da Unisinos (www.moodle.unisinos.br) em nome do aluno logado. " +
        "Se não houver login (ou ele expirar), use moodle_login. Comece por moodle_list_courses para obter os ids das disciplinas. " +
        "Datas estão no fuso de São Paulo. Para ler materiais (PDF, slides etc.) use moodle_read_file com o fileurl; para salvar no computador, moodle_download_file. Ferramentas que alteram o Moodle (entregar/remover envio, responder/criar/apagar no fórum, enviar mensagem) funcionam em duas etapas: prévia + confirmação explícita do aluno. " +
        QUIZ_RULE,
    },
  );
  registerAuthTools(server);
  registerCourseTools(server);
  registerCalendarTools(server);
  registerUpdateTools(server);
  registerGradeTools(server);
  registerAssignmentTools(server);
  registerFileTools(server);
  registerSubmitTools(server);
  registerForumTools(server);
  registerMessageTools(server);
  registerQuizTools(server);
  return server;
}

