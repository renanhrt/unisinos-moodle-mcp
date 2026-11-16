import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MoodleError, type MoodleClient } from "../moodle/client.js";
import { compact, formatDate, htmlToText, shortCourseName } from "../moodle/format.js";
import { getSession } from "../moodle/session.js";
import { escapeAsHtml } from "../moodle/submission.js";
import { getEnrolledCourses } from "./courses.js";
import {
  CONFIRMATION_CODE_DESC,
  CONFIRMATION_RULE,
  confirmedAction,
  DELETES_IN_MOODLE,
  describeError,
  READ_ONLY,
  runTool,
  WRITES_MOODLE,
} from "./helpers.js";

interface Forum {
  id: number;
  course: number;
  cmid: number;
  type: string;
  name: string;
  intro?: string;
  duedate?: number;
  cutoffdate?: number;
  numdiscussions?: number;
  cancreatediscussions?: boolean;
  lockdiscussionafter?: number;
}

interface Discussion {
  id: number;
  discussion: number;
  name: string;
  subject: string;
  message: string;
  userfullname: string;
  created: number;
  timemodified: number;
  numreplies: number;
  numunread: number;
  pinned: boolean;
  locked: boolean;
  canreply: boolean;
}

interface Post {
  id: number;
  subject: string;
  replysubject?: string;
  message: string;
  author: { id: number; fullname: string };
  discussionid: number;
  hasparent: boolean;
  parentid: number | null;
  timecreated: number;
  unread?: boolean | null;
  isdeleted: boolean;
  isprivatereply: boolean;
  capabilities: { reply: boolean; delete: boolean; edit: boolean };
  attachments?: { filename: string; url: string; filesize?: number }[];
}

const FORUM_TYPES: Record<string, string> = {
  news: "Avisos (só professores postam)",
  general: "Fórum geral",
  single: "Discussão única",
  qanda: "Perguntas e respostas",
  eachuser: "Cada um posta um tópico",
  blog: "Blog",
};

async function getPost(client: MoodleClient, postId: number): Promise<Post> {
  const r = await client.call<{ post: Post }>("mod_forum_get_discussion_post", { postid: postId });
  return r.post;
}

export function registerForumTools(server: McpServer): void {
  server.registerTool(
    "moodle_list_forums",
    {
      title: "Listar fóruns",
      description: "Lista os fóruns das disciplinas (inclui os fóruns de Avisos dos professores), com número de tópicos e se o aluno pode criar tópicos.",
      inputSchema: {
        courseids: z.array(z.number().int().positive()).optional().describe("limitar a estas disciplinas (padrão: todas)"),
      },
      annotations: READ_ONLY,
    },
    ({ courseids }) =>
      runTool(async ({ client, site }) => {
        const courses = await getEnrolledCourses(client, site.userid);
        const names = new Map(courses.map((c) => [c.id, shortCourseName(c.fullname)]));
        const ids = courseids ?? courses.map((c) => c.id);
        const forums = await client.call<Forum[]>("mod_forum_get_forums_by_courses", { courseids: ids });
        return forums.map((f) =>
          compact({
            forumId: f.id,
            cmid: f.cmid,
            name: f.name,
            course: names.get(f.course),
            courseid: f.course,
            type: FORUM_TYPES[f.type] ?? f.type,
            discussions: f.numdiscussions,
            canCreateDiscussion: f.cancreatediscussions,
            due: formatDate(f.duedate),
          }),
        );
      }),
  );

  server.registerTool(
    "moodle_list_discussions",
    {
      title: "Tópicos de um fórum",
      description: "Lista os tópicos (discussões) de um fórum, mais recentes primeiro, com autor, respostas e não lidas.",
      inputSchema: {
        forumId: z.number().int().positive().describe("forumId (de moodle_list_forums)"),
        page: z.number().int().min(0).default(0),
        perPage: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_ONLY,
    },
    ({ forumId, page, perPage }) =>
      runTool(async ({ client }) => {
        const r = await client.call<{ discussions: Discussion[] }>("mod_forum_get_forum_discussions", {
          forumid: forumId,
          page,
          perpage: perPage,
        });
        return r.discussions.map((d) =>
          compact({
            discussionId: d.discussion,
            firstPostId: d.id,
            title: d.name,
            author: d.userfullname,
            created: formatDate(d.created),
            lastActivity: formatDate(d.timemodified),
            replies: d.numreplies,
            unread: d.numunread || null,
            pinned: d.pinned || null,
            locked: d.locked || null,
            canReply: d.canreply,
            preview: htmlToText(d.message, 300),
          }),
        );
      }),
  );

  server.registerTool(
    "moodle_read_discussion",
    {
      title: "Ler tópico do fórum",
      description:
        "Mostra todas as mensagens de um tópico em ordem, com autor, data, anexos (use moodle_read_file no fileurl) e se o aluno pode responder a cada uma.",
      inputSchema: {
        discussionId: z.number().int().positive().describe("discussionId (de moodle_list_discussions)"),
      },
      annotations: READ_ONLY,
    },
    ({ discussionId }) =>
      runTool(async ({ client }) => {
        const r = await client.call<{ posts: Post[] }>("mod_forum_get_discussion_posts", {
          discussionid: discussionId,
          sortby: "created",
          sortdirection: "ASC",
        });
        return r.posts
          .filter((p) => !p.isdeleted)
          .map((p) =>
            compact({
              postId: p.id,
              replyTo: p.parentid,
              author: p.author.fullname,
              when: formatDate(p.timecreated),
              subject: p.subject,
              text: htmlToText(p.message, 6000),
              attachments: p.attachments?.map((a) => ({ filename: a.filename, fileurl: a.url })),
              unread: p.unread || null,
              private: p.isprivatereply || null,
              canReply: p.capabilities.reply,
              canDelete: p.capabilities.delete || null,
            }),
          );
      }),
  );

  server.registerTool(
    "moodle_reply_forum",
    {
      title: "Responder no fórum",
      description: `Publica uma resposta a uma mensagem de um fórum (visível para a turma). ${CONFIRMATION_RULE}`,
      inputSchema: {
        postId: z.number().int().positive().describe("postId da mensagem que está sendo respondida (de moodle_read_discussion)"),
        message: z.string().min(1).max(20_000).describe("texto da resposta, em texto simples"),
        subject: z.string().max(255).optional().describe('assunto (padrão: "Re: <assunto original>")'),
        confirmationCode: z.string().optional().describe(CONFIRMATION_CODE_DESC),
      },
      annotations: WRITES_MOODLE,
    },
    async ({ postId, message, subject, confirmationCode }): Promise<CallToolResult> => {
      try {
        const { client } = await getSession();
        const parent = await getPost(client, postId);
        const finalSubject = subject ?? parent.replysubject ?? `Re: ${parent.subject}`;
        const errors: string[] = [];
        if (!parent.capabilities.reply) errors.push("O aluno não tem permissão para responder a esta mensagem (ex.: fórum de Avisos ou tópico travado).");
        const preview = [
          `Respondendo a: ${parent.author.fullname} — "${parent.subject}" (${formatDate(parent.timecreated)})`,
          `Trecho: ${htmlToText(parent.message, 300)}`,
          "",
          `Assunto: ${finalSubject}`,
          "Resposta:",
          indent(message),
          "",
          "Atenção:",
          "  ! A resposta fica visível para a turma e pode ser enviada por e-mail aos inscritos no fórum (após ~30 min).",
          "  ! Dá para apagar com moodle_delete_forum_post enquanto o Moodle permitir (normalmente 30 min).",
        ].join("\n");
        return confirmedAction({
          kind: "forum-reply",
          payload: { postId, message, finalSubject },
          preview,
          errors,
          toolName: "moodle_reply_forum",
          confirmationCode,
          execute: async () => {
            const r = await client.call<{ postid: number; warnings?: { message: string }[] }>("mod_forum_add_discussion_post", {
              postid: postId,
              subject: finalSubject,
              message: escapeAsHtml(message),
              messageformat: 1,
            });
            if (!r.postid) throw new MoodleError(`O Moodle não publicou: ${(r.warnings ?? []).map((w) => w.message).join("; ")}`);
            return `✅ Resposta publicada (postId ${r.postid}) no tópico "${parent.subject}".`;
          },
        });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: describeError(err) }] };
      }
    },
  );

  server.registerTool(
    "moodle_create_discussion",
    {
      title: "Criar tópico no fórum",
      description: `Cria um novo tópico em um fórum (visível para a turma). Só funciona em fóruns onde o aluno pode criar tópicos. ${CONFIRMATION_RULE}`,
      inputSchema: {
        forumId: z.number().int().positive().describe("forumId (de moodle_list_forums)"),
        subject: z.string().min(1).max(255).describe("título do tópico"),
        message: z.string().min(1).max(20_000).describe("texto, em texto simples"),
        confirmationCode: z.string().optional().describe(CONFIRMATION_CODE_DESC),
      },
      annotations: WRITES_MOODLE,
    },
    async ({ forumId, subject, message, confirmationCode }): Promise<CallToolResult> => {
      try {
        const { client, site } = await getSession();
        const courses = await getEnrolledCourses(client, site.userid);
        const forums = await client.call<Forum[]>("mod_forum_get_forums_by_courses", { courseids: courses.map((c) => c.id) });
        const forum = forums.find((f) => f.id === forumId);
        const errors: string[] = [];
        if (!forum) errors.push(`Fórum ${forumId} não encontrado nas disciplinas do aluno.`);
        else {
          const can = await client.call<{ status: boolean }>("mod_forum_can_add_discussion", { forumid: forumId });
          if (!can.status) errors.push(`O aluno não pode criar tópicos em "${forum.name}" (${FORUM_TYPES[forum.type] ?? forum.type}).`);
        }
        const course = forum ? shortCourseName(courses.find((c) => c.id === forum.course)?.fullname) : "?";
        const preview = [
          `Fórum: ${forum?.name ?? forumId} — ${course}`,
          `Título: ${subject}`,
          "Mensagem:",
          indent(message),
          "",
          "Atenção:",
          "  ! O tópico fica visível para a turma e pode ser enviado por e-mail aos inscritos (após ~30 min).",
        ].join("\n");
        return confirmedAction({
          kind: "forum-discussion",
          payload: { forumId, subject, message },
          preview,
          errors,
          toolName: "moodle_create_discussion",
          confirmationCode,
          execute: async () => {
            const r = await client.call<{ discussionid: number; warnings?: { message: string }[] }>("mod_forum_add_discussion", {
              forumid: forumId,
              subject,
              message: escapeAsHtml(message),
            });
            if (!r.discussionid) throw new MoodleError(`O Moodle não criou o tópico: ${(r.warnings ?? []).map((w) => w.message).join("; ")}`);
            return `✅ Tópico "${subject}" criado (discussionId ${r.discussionid}).`;
          },
        });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: describeError(err) }] };
      }
    },
  );

  server.registerTool(
    "moodle_delete_forum_post",
    {
      title: "Apagar mensagem do fórum",
      description: `Apaga uma mensagem do próprio aluno em um fórum (se for a primeira do tópico, apaga o tópico inteiro). ${CONFIRMATION_RULE}`,
      inputSchema: {
        postId: z.number().int().positive().describe("postId (de moodle_read_discussion)"),
        confirmationCode: z.string().optional().describe(CONFIRMATION_CODE_DESC),
      },
      annotations: DELETES_IN_MOODLE,
    },
    async ({ postId, confirmationCode }): Promise<CallToolResult> => {
      try {
        const { client, site } = await getSession();
        const post = await getPost(client, postId);
        const errors: string[] = [];
        if (post.author.id !== site.userid) errors.push("Só é possível apagar mensagens do próprio aluno.");
        else if (!post.capabilities.delete) errors.push("O Moodle não permite mais apagar esta mensagem (o prazo de edição pode ter passado).");
        const preview = [
          `Mensagem: "${post.subject}" de ${post.author.fullname} (${formatDate(post.timecreated)})`,
          `Trecho: ${htmlToText(post.message, 300)}`,
          ...(post.hasparent ? [] : ["", "Atenção:", "  ! Esta é a primeira mensagem do tópico: o TÓPICO INTEIRO (com as respostas) será apagado."]),
        ].join("\n");
        return confirmedAction({
          kind: "forum-delete",
          payload: { postId, discussion: post.discussionid },
          preview,
          errors,
          toolName: "moodle_delete_forum_post",
          confirmationCode,
          execute: async () => {
            const r = await client.call<{ status: boolean; warnings?: { message: string }[] }>("mod_forum_delete_post", { postid: postId });
            if (!r.status) throw new MoodleError(`O Moodle não apagou: ${(r.warnings ?? []).map((w) => w.message).join("; ")}`);
            return `✅ Mensagem ${postId} apagada.`;
          },
        });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: describeError(err) }] };
      }
    },
  );
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
