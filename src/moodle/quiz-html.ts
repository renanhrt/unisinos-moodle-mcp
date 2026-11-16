import { parse, type HTMLElement } from "node-html-parser";
import { htmlToText } from "./format.js";

/**
 * Lê o HTML de uma questão do Moodle (o mesmo que o app oficial recebe em
 * mod_quiz_get_attempt_data) e transforma em campos simples: opções de múltipla
 * escolha, caixas de seleção, campos de texto, listas e redação.
 *
 * Só descreve o que está na tela do aluno. Não existe "resposta certa" neste HTML
 * enquanto a tentativa está em andamento.
 */

export interface ChoiceOption {
  /** "a", "b", "c"… (como aparece no Moodle) */
  letter: string;
  value: string;
  text: string;
  selected: boolean;
}

export interface CheckboxOption {
  letter: string;
  name: string;
  text: string;
  checked: boolean;
}

export interface TextField {
  name: string;
  label: string;
  value: string;
}

export interface SelectField {
  name: string;
  label: string;
  options: { value: string; text: string }[];
  selected: string | null;
}

export interface ParsedQuestion {
  /** prefixo dos campos, ex.: "q12345:3_" */
  prefix: string;
  number: string | null;
  text: string;
  images: string[];
  prompt: string | null;
  /** múltipla escolha com uma resposta (rádio) */
  radio?: { name: string; options: ChoiceOption[] };
  /** múltipla escolha com várias respostas */
  checkboxes?: CheckboxOption[];
  texts?: TextField[];
  selects?: SelectField[];
  essays?: TextField[];
  /** campos ocultos do Moodle que precisam voltar no envio (sequencecheck etc.) */
  hidden: { name: string; value: string }[];
  /** só na revisão */
  review?: { state: string | null; mark: string | null; feedback: string | null; rightAnswer: string | null };
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function textOf(el: HTMLElement | null | undefined, max?: number): string {
  if (!el) return "";
  return htmlToText(el.innerHTML, max);
}

function labelFor(root: HTMLElement, input: HTMLElement): HTMLElement | null {
  const labelledBy = input.getAttribute("aria-labelledby");
  if (labelledBy) {
    const el = root.querySelector(`[id="${labelledBy}"]`);
    if (el) return el;
  }
  const id = input.getAttribute("id");
  if (id) {
    const el = root.querySelector(`label[for="${id}"]`);
    if (el) return el;
  }
  // Moodle antigo: <input …><label>texto</label> dentro do mesmo <div class="rN">
  return input.parentNode?.querySelector("label") ?? null;
}

/** Separa "a. " do resto do texto da opção. */
function splitLetter(label: HTMLElement | null, fallbackIndex: number): { letter: string; text: string } {
  const num = label?.querySelector(".answernumber");
  const letter = (num?.text ?? "").trim().replace(/[.)]\s*$/, "").toLowerCase() || LETTERS[fallbackIndex] || String(fallbackIndex + 1);
  if (num) num.remove();
  return { letter, text: textOf(label) };
}

function imagesIn(el: HTMLElement | null): string[] {
  if (!el) return [];
  return el
    .querySelectorAll("img")
    .map((i) => i.getAttribute("src") ?? "")
    .filter((s) => /^https?:\/\//.test(s));
}

export function parseQuestionHtml(html: string): ParsedQuestion {
  const root = parse(html);
  const seq = root.querySelectorAll("input").find((i) => (i.getAttribute("name") ?? "").endsWith(":sequencecheck"));
  const anyField = seq ?? root.querySelectorAll("input, select, textarea").find((i) => /^q\d+:\d+_/.test(i.getAttribute("name") ?? ""));
  const prefix = /^(q\d+:\d+_)/.exec(anyField?.getAttribute("name") ?? "")?.[1] ?? "";

  const qtext = root.querySelector(".qtext");
  const q: ParsedQuestion = {
    prefix,
    number: root.querySelector(".qno")?.text.trim() || null,
    text: textOf(qtext),
    images: imagesIn(qtext),
    prompt: root.querySelector(".prompt")?.text.trim() || null,
    hidden: [],
  };

  const own = (el: HTMLElement) => {
    const name = el.getAttribute("name") ?? "";
    return prefix !== "" && name.startsWith(prefix) && !name.endsWith(":flagged");
  };

  // Ocultos (sequencecheck, choiceN=0 antes do checkbox, answerformat…)
  for (const el of root.querySelectorAll('input[type="hidden"]').filter(own)) {
    q.hidden.push({ name: el.getAttribute("name")!, value: el.getAttribute("value") ?? "" });
  }

  // Rádio (múltipla escolha com uma resposta / verdadeiro-falso)
  const radios = root.querySelectorAll('input[type="radio"]').filter(own);
  const real = radios.filter((r) => r.getAttribute("value") !== "-1"); // "-1" = "limpar minha escolha"
  if (real.length) {
    q.radio = {
      name: real[0]!.getAttribute("name")!,
      options: real.map((r, i) => {
        const { letter, text } = splitLetter(labelFor(root, r), i);
        return { letter, value: r.getAttribute("value") ?? "", text, selected: r.hasAttribute("checked") };
      }),
    };
  }

  // Caixas de seleção (múltipla escolha com várias respostas)
  const boxes = root.querySelectorAll('input[type="checkbox"]').filter(own);
  if (boxes.length) {
    q.checkboxes = boxes.map((b, i) => {
      const { letter, text } = splitLetter(labelFor(root, b), i);
      return { letter, name: b.getAttribute("name")!, text, checked: b.hasAttribute("checked") };
    });
  }

  // Texto curto / numérico
  const texts = root.querySelectorAll('input[type="text"], input[type="number"], input:not([type])').filter(own);
  if (texts.length) {
    q.texts = texts.map((t, i) => ({
      name: t.getAttribute("name")!,
      label: textOf(labelFor(root, t)) || (texts.length > 1 ? `Campo ${i + 1}` : "Resposta"),
      value: t.getAttribute("value") ?? "",
    }));
  }

  // Listas (associação, selecionar palavras faltantes…)
  const selects = root.querySelectorAll("select").filter(own);
  if (selects.length) {
    q.selects = selects.map((s, i) => {
      // Associação: o enunciado do item fica na célula .text da mesma linha; o <label> é só "Resposta 1".
      const row = s.closest("tr");
      const rowText = row?.querySelector(".text");
      const label = textOf(rowText) || textOf(labelFor(root, s)) || `Lacuna ${i + 1}`;
      const isPlaceholder = (o: HTMLElement) =>
        (o.getAttribute("value") ?? "") === "" || /^(escolher|choose)\b/i.test(o.text.trim());
      const options = s
        .querySelectorAll("option")
        .filter((o) => !isPlaceholder(o))
        .map((o) => ({ value: o.getAttribute("value")!, text: htmlToText(o.innerHTML) }));
      const sel = s.querySelectorAll("option").find((o) => o.hasAttribute("selected") && !isPlaceholder(o));
      return { name: s.getAttribute("name")!, label: label.replace(/\s*:\s*$/, ""), options, selected: sel?.getAttribute("value") ?? null };
    });
  }

  // Redação
  const areas = root.querySelectorAll("textarea").filter(own);
  if (areas.length) {
    q.essays = areas.map((a) => ({ name: a.getAttribute("name")!, label: "Redação", value: htmlToText(a.innerHTML) }));
  }

  // Revisão (só aparece depois de finalizar, se o professor liberar)
  const state = root.querySelector(".state")?.text.trim() || null;
  const mark = root.querySelector(".grade")?.text.trim() || null;
  const feedback = [".specificfeedback", ".generalfeedback", ".numpartscorrect"]
    .map((sel) => textOf(root.querySelector(sel)))
    .filter(Boolean)
    .join("\n");
  const rightAnswer = textOf(root.querySelector(".rightanswer")) || null;
  if (rightAnswer || feedback || root.querySelector(".outcome")) {
    q.review = { state, mark, feedback: feedback || null, rightAnswer };
  }
  return q;
}

/** Resposta pedida pelo aluno, em forma livre: "b", ["a","c"], "3,5" ou {"Campo": "valor"}. */
export type AnswerInput = string | string[] | Record<string, string>;

export class AnswerError extends Error {}

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Acha UMA opção pela letra ("b", "b)", "letra B"), pela posição ("2") ou pelo texto exato.
 * Se o pedido puder significar opções diferentes (ex.: "1" = 1ª opção ou a opção com texto "1"),
 * recusa e pede a letra. Nunca adivinha.
 */
function pickOption<T extends { letter: string; text: string }>(options: T[], wanted: string): T {
  const list = () => options.map((o) => `${o.letter}) ${o.text.slice(0, 60)}`).join(" | ");
  const raw = norm(wanted);
  const explicitLetter = /^(letra|opcao|alternativa)\s+/.test(raw);
  const w = raw.replace(/^(letra|opcao|alternativa)\s+/, "").replace(/[.)]$/, "");

  const matches = new Set<T>();
  const byLetter = options.find((o) => norm(o.letter) === w);
  if (byLetter) matches.add(byLetter);
  if (explicitLetter) {
    if (byLetter) return byLetter;
    throw new AnswerError(`Não existe a letra "${w}". Opções: ${list()}`);
  }
  if (/^\d+$/.test(w) && options[Number(w) - 1]) matches.add(options[Number(w) - 1]!);
  for (const o of options) if (norm(o.text) === w) matches.add(o);

  if (matches.size === 1) return [...matches][0]!;
  if (matches.size > 1) {
    throw new AnswerError(`"${wanted}" é ambíguo (pode ser ${[...matches].map((o) => `${o.letter})`).join(" ou ")}). Peça ao aluno a letra. Opções: ${list()}`);
  }
  throw new AnswerError(`"${wanted}" não corresponde a nenhuma opção. Use a letra: ${list()}`);
}

function pickByLabel<T extends { label: string }>(fields: T[], key: string): T {
  const k = norm(key);
  const found = fields.filter((f) => norm(f.label) === k);
  if (found.length === 1) return found[0]!;
  if (/^\d+$/.test(k) && fields[Number(k) - 1]) return fields[Number(k) - 1]!;
  throw new AnswerError(`Campo "${key}" não encontrado. Campos: ${fields.map((f, i) => `${i + 1}) ${f.label}`).join(" | ")}`);
}

/**
 * Monta os dados do formulário a partir EXATAMENTE do que o aluno pediu.
 * Devolve também uma descrição legível do que será marcado.
 */
export function buildAnswerData(
  q: ParsedQuestion,
  slot: number,
  answer: AnswerInput,
): { data: { name: string; value: string }[]; summary: string } {
  const data = new Map<string, string>(q.hidden.map((h) => [h.name, h.value]));
  const summary: string[] = [];

  if (q.radio) {
    if (typeof answer !== "string") throw new AnswerError("Esta questão aceita UMA opção: informe a letra (ex.: \"b\").");
    if (/^(limpar|nenhuma|-1)$/i.test(answer.trim())) {
      data.set(q.radio.name, "-1");
      summary.push("limpar a escolha");
    } else {
      const opt = pickOption(q.radio.options, answer);
      data.set(q.radio.name, opt.value);
      summary.push(`${opt.letter}) ${opt.text}`);
    }
  } else if (q.checkboxes) {
    const list = Array.isArray(answer) ? answer : typeof answer === "string" ? answer.split(/[,;]|\s+e\s+/) : null;
    if (!list) throw new AnswerError('Esta questão aceita várias opções: informe as letras, ex.: ["a","c"].');
    const chosen = new Set(list.filter((s) => s.trim()).map((s) => pickOption(q.checkboxes!, s).name));
    for (const b of q.checkboxes) {
      data.set(b.name, chosen.has(b.name) ? "1" : "0");
      if (chosen.has(b.name)) summary.push(`${b.letter}) ${b.text}`);
    }
    if (!summary.length) summary.push("nenhuma opção marcada");
  } else if (q.texts || q.selects || q.essays) {
    const fields = [
      ...(q.texts ?? []).map((f) => ({ ...f, kind: "text" as const })),
      ...(q.essays ?? []).map((f) => ({ ...f, kind: "essay" as const })),
      ...(q.selects ?? []).map((f) => ({ ...f, kind: "select" as const, value: "" })),
    ];
    const entries: [string, string][] =
      typeof answer === "string" ? (fields.length === 1 ? [["1", answer]] : []) : Array.isArray(answer) ? answer.map((v, i) => [String(i + 1), v]) : Object.entries(answer);
    if (!entries.length) {
      throw new AnswerError(`Esta questão tem ${fields.length} campos; informe um objeto {"campo": "valor"}. Campos: ${fields.map((f, i) => `${i + 1}) ${f.label}`).join(" | ")}`);
    }
    for (const [key, value] of entries) {
      const f = pickByLabel(fields, key);
      if (f.kind === "select") {
        const opt = pickOption(
          f.options.map((o, i) => ({ ...o, letter: String.fromCharCode(97 + i) })),
          value,
        );
        data.set(f.name, opt.value);
        summary.push(`${f.label}: ${opt.text}`);
      } else {
        data.set(f.name, f.kind === "essay" ? `<p>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>` : value);
        summary.push(`${f.label}: ${value}`);
      }
    }
  } else {
    throw new AnswerError("Tipo de questão não suportado pelo MCP. Responda esta pelo Moodle no navegador.");
  }

  data.set("slots", String(slot));
  return { data: [...data].map(([name, value]) => ({ name, value })), summary: summary.join("; ") };
}

/** Resumo legível do que está marcado agora. */
export function currentAnswer(q: ParsedQuestion): string | null {
  if (q.radio) {
    const o = q.radio.options.find((x) => x.selected);
    return o ? `${o.letter}) ${o.text}` : null;
  }
  if (q.checkboxes) {
    const on = q.checkboxes.filter((c) => c.checked);
    return on.length ? on.map((c) => `${c.letter}) ${c.text}`).join("; ") : null;
  }
  const parts = [
    ...(q.texts ?? []).filter((t) => t.value).map((t) => `${t.label}: ${t.value}`),
    ...(q.essays ?? []).filter((t) => t.value).map((t) => `${t.label}: ${t.value.slice(0, 200)}`),
    ...(q.selects ?? []).filter((s) => s.selected).map((s) => `${s.label}: ${s.options.find((o) => o.value === s.selected)?.text}`),
  ];
  return parts.length ? parts.join("; ") : null;
}
