import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MoodleError, type MoodleClient } from "../moodle/client.js";
import { compact, formatDate, htmlToText, shortenCourseNamesIn } from "../moodle/format.js";
import { getSession } from "../moodle/session.js";
import { escapeAsHtml } from "../moodle/submission.js";
import { getEnrolledCourses } from "./courses.js";
import {
  CONFIRMATION_CODE_DESC,
  CONFIRMATION_RULE,
  confirmedAction,
  describeError,
  READ_ONLY,
  runTool,
  WRITES_MOODLE,
} from "./helpers.js";

interface Member {
  id: number;
  fullname: string;
  canmessage?: boolean | null;
  requirescontact?: boolean | null;
  isblocked?: boolean;
  isdeleted?: boolean;
}

interface Message {
  id: number;
  useridfrom: number;
  text: string;
  timecreated: number;
}

interface Conversation {
  id: number;
  name?: string | null;
  type: number;
  membercount: number;
  isread?: boolean;
  unreadcount?: number | null;
  members: Member[];
  messages: Message[];
}

const CONVERSATION_TYPES: Record<number, string> = { 1: "privada", 2: "grupo", 3: "anotações pessoais" };

function conversationName(c: Conversation, selfId: number): string {
  if (c.type === 3) return "Anotações pessoais (só você vê)";
  if (c.name) return c.name;
  return c.members.filter((m) => m.id !== selfId).map((m) => m.fullname).join(", ") || "(sem participantes)";
}

interface Notification {
  id: number;
  subject: string;
  smallmessage?: string;
  text?: string;
  fullmessage?: string;
  contexturl?: string | null;
  contexturlname?: string | null;
  timecreated: number;
  read: boolean;
  component?: string;
  eventtype?: string;
}

const NOTIFICATION_TYPES: Record<string, string> = {
  "moodle/coursecontentupdated": "conteúdo novo/alterado",
  "mod_assign/assign_due_digest": "prazos de tarefas",
  "mod_assign/assign_notification": "tarefa",
  "mod_assign/assign_due_soon": "tarefa vence em breve",
  "mod_assign/assign_overdue": "tarefa atrasada",
  "mod_quiz/quiz_open_soon": "questionário abre em breve",
  "mod_quiz/submission": "questionário",
  "mod_forum/posts": "fórum",
  "mod_forum/digests": "fórum (resumo)",
  "moodle/gradenotifications": "nota",
  "moodle/instantmessage": "mensagem",
};

export function registerMessageTools(server: McpServer): void {
  server.registerTool(
    "moodle_list_notifications",
    {
      title: "Notificações",
      description: "Lista as notificações do Moodle (conteúdo novo, prazos, notas, fóruns etc.), mais recentes primeiro.",
      inputSchema: {
        unreadOnly: z.boolean().default(false).describe("só as não lidas"),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_ONLY,
    },
    ({ unreadOnly, limit }) =>
      runTool(async ({ client, site }) => {
        const [r, courses] = await Promise.all([
          client.call<{ notifications: Notification[]; unreadcount: number }>("message_popup_get_popup_notifications", {
            useridto: site.userid,
            newestfirst: true,
            limit: unreadOnly ? 50 : limit,
            offset: 0,
          }),
          getEnrolledCourses(client, site.userid),
        ]);
        const fullnames = courses.map((c) => c.fullname);
        const tidy = (s: string) =>
          shortenCourseNamesIn(s, fullnames)
            .replace(/\s*\.?\s*(Change your notification preferences|Alterar suas preferências de notificação).*$/is, "")
            .replace(/\s+([.,;:])/g, "$1")
            .trim();
        const list = r.notifications.filter((n) => !unreadOnly || !n.read).slice(0, limit);
        return {
          unread: r.unreadcount,
          notifications: list.map((n) => {
            const key = `${n.component}/${n.eventtype}`;
            const subject = tidy(htmlToText(n.subject));
            const body = tidy(htmlToText(n.smallmessage || n.fullmessage || n.text, 600));
            return compact({
              when: formatDate(n.timecreated),
              type: NOTIFICATION_TYPES[key] ?? key,
              subject,
              text: body === subject ? null : body,
              link: n.contexturl,
              unread: n.read ? null : true,
            });
          }),
        };
      }),
  );

  server.registerTool(
    "moodle_list_conversations",
    {
      title: "Conversas (mensagens)",
      description: "Lista as conversas de mensagens do aluno no Moodle com a última mensagem e quantas não lidas.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () =>
      runTool(async ({ client, site }) => {
        const r = await client.call<{ conversations: Conversation[] }>("core_message_get_conversations", {
          userid: site.userid,
          limitnum: 50,
        });
        return r.conversations.map((c) => {
          const last = c.messages[0];
          const from = last ? (last.useridfrom === site.userid ? "você" : c.members.find((m) => m.id === last.useridfrom)?.fullname) : null;
          return compact({
            conversationId: c.id,
            with: conversationName(c, site.userid),
            type: CONVERSATION_TYPES[c.type] ?? c.type,
            unread: c.unreadcount || null,
            lastMessage: last ? `${from ?? "?"} (${formatDate(last.timecreated)}): ${htmlToText(last.text, 200)}` : null,
          });
        });
      }),
  );

  server.registerTool(
    "moodle_read_conversation",
    {
      title: "Ler conversa",
      description: "Mostra as mensagens de uma conversa em ordem cronológica (as mais recentes).",
      inputSchema: {
        conversationId: z.number().int().positive().describe("conversationId (de moodle_list_conversations)"),
        limit: z.number().int().min(1).max(100).default(30).describe("quantas mensagens recentes"),
      },
      annotations: READ_ONLY,
    },
    ({ conversationId, limit }) =>
      runTool(async ({ client, site }) => {
        const r = await client.call<{ id: number; members: Member[]; messages: Message[] }>("core_message_get_conversation_messages", {
          currentuserid: site.userid,
          convid: conversationId,
          limitnum: limit,
          newest: true,
        });
        const names = new Map(r.members.map((m) => [m.id, m.fullname]));
        return [...r.messages]
          .sort((a, b) => a.timecreated - b.timecreated || a.id - b.id)
          .map((m) => ({
            from: m.useridfrom === site.userid ? "você" : names.get(m.useridfrom) ?? `usuário ${m.useridfrom}`,
            when: formatDate(m.timecreated),
            text: htmlToText(m.text, 4000),
          }));
      }),
  );

  server.registerTool(
    "moodle_search_people",
    {
      title: "Procurar pessoas",
      description: "Procura professores e colegas pelo nome para mandar mensagem. Devolve userId e, se houver, a conversa existente.",
      inputSchema: { query: z.string().min(2).max(100).describe("parte do nome") },
      annotations: READ_ONLY,
    },
    ({ query }) =>
      runTool(async ({ client, site }) => {
        const r = await client.call<{
          contacts: (Member & { conversations?: { id: number }[] })[];
          noncontacts: (Member & { conversations?: { id: number }[] })[];
        }>("core_message_message_search_users", { userid: site.userid, search: query, limitnum: 20 });
        return [...r.contacts.map((u) => ({ u, contact: true })), ...r.noncontacts.map((u) => ({ u, contact: false }))].map(({ u, contact }) =>
          compact({ userId: u.id, name: u.fullname, contact: contact || null, conversationId: u.conversations?.[0]?.id }),
        );
      }),
  );

  server.registerTool(
    "moodle_send_message",
    {
      title: "Enviar mensagem",
      description:
        "Envia uma mensagem privada no Moodle, para uma conversa existente (conversationId) ou para uma pessoa (toUserId, de moodle_search_people). " +
        `Mensagens enviadas não podem ser apagadas para o destinatário. ${CONFIRMATION_RULE}`,
      inputSchema: {
        conversationId: z.number().int().positive().optional().describe("conversa existente"),
        toUserId: z.number().int().positive().optional().describe("ou: id da pessoa (de moodle_search_people)"),
        text: z.string().min(1).max(4000).describe("texto da mensagem, em texto simples"),
        confirmationCode: z.string().optional().describe(CONFIRMATION_CODE_DESC),
      },
      annotations: WRITES_MOODLE,
    },
    async ({ conversationId, toUserId, text, confirmationCode }): Promise<CallToolResult> => {
      try {
        const { client, site } = await getSession();
        const errors: string[] = [];
        let recipients = "?";
        let targetConversation = conversationId;

        if ((conversationId === undefined) === (toUserId === undefined)) {
          errors.push("Informe exatamente um destino: conversationId OU toUserId.");
        } else if (conversationId !== undefined) {
          const c = await client.call<Conversation>("core_message_get_conversation", {
            userid: site.userid,
            conversationid: conversationId,
            includecontactrequests: false,
            includeprivacyinfo: false,
            memberlimit: 50,
          });
          recipients = conversationName(c, site.userid);
          const others = c.members.filter((m) => m.id !== site.userid);
          if (others.some((m) => m.isdeleted)) errors.push("A conversa tem um participante com conta excluída.");
        } else if (toUserId === site.userid) {
          const self = await client.call<{ id: number }>("core_message_get_self_conversation", { userid: site.userid });
          targetConversation = self.id;
          recipients = "Anotações pessoais (só você vê)";
        } else {
          const [m] = await client.call<Member[]>("core_message_get_member_info", {
            referenceuserid: site.userid,
            userids: [toUserId!],
            includecontactrequests: false,
            includeprivacyinfo: true,
          });
          if (!m) errors.push(`Pessoa ${toUserId} não encontrada.`);
          else {
            recipients = m.fullname;
            if (m.isdeleted) errors.push("A conta desta pessoa foi excluída.");
            if (m.isblocked) errors.push("Você bloqueou esta pessoa.");
            if (m.canmessage === false) {
              errors.push(m.requirescontact ? "Esta pessoa só aceita mensagens de contatos." : "O Moodle não permite enviar mensagem para esta pessoa.");
            }
            targetConversation = await existingConversation(client, site.userid, toUserId!);
          }
        }

        const preview = [
          `Para: ${recipients}`,
          "Mensagem:",
          ...text.split("\n").map((l) => `    ${l}`),
          ...(recipients.startsWith("Anotações pessoais")
            ? []
            : ["", "Atenção:", "  ! Depois de enviada, a mensagem não pode ser apagada para o destinatário (ele também pode recebê-la por e-mail)."]),
        ].join("\n");

        return confirmedAction({
          kind: "message",
          payload: { conversationId, toUserId, targetConversation, text, recipients },
          preview,
          errors,
          toolName: "moodle_send_message",
          confirmationCode,
          execute: async () => {
            const html = escapeAsHtml(text);
            if (targetConversation !== undefined) {
              const sent = await client.call<Message[]>("core_message_send_messages_to_conversation", {
                conversationid: targetConversation,
                messages: [{ text: html, textformat: 1 }],
              });
              if (!sent?.[0]?.id) throw new MoodleError("O Moodle não confirmou o envio da mensagem.");
              return `✅ Mensagem enviada para ${recipients} (conversationId ${targetConversation}).`;
            }
            const [r] = await client.call<{ msgid: number; errormessage?: string; conversationid?: number }[]>(
              "core_message_send_instant_messages",
              { messages: [{ touserid: toUserId!, text: html, textformat: 1 }] },
            );
            if (!r || r.msgid === -1) throw new MoodleError(`O Moodle não enviou a mensagem: ${r?.errormessage ?? "sem detalhes"}`);
            return `✅ Mensagem enviada para ${recipients}${r.conversationid ? ` (conversationId ${r.conversationid})` : ""}.`;
          },
        });
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: describeError(err) }] };
      }
    },
  );
}

async function existingConversation(client: MoodleClient, selfId: number, otherId: number): Promise<number | undefined> {
  try {
    const c = await client.call<{ id: number }>("core_message_get_conversation_between_users", {
      userid: selfId,
      otheruserid: otherId,
      includecontactrequests: false,
      includeprivacyinfo: false,
      memberlimit: 0,
      memberoffset: 0,
      messagelimit: 0,
      messageoffset: 0,
    });
    return c?.id;
  } catch (err) {
    if (err instanceof MoodleError && !err.isAuthError) return undefined; // ainda não existe conversa
    throw err;
  }
}
