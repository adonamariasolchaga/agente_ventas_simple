"use strict";

const chat = document.getElementById("chat");
const form = document.getElementById("formulario");
const input = document.getElementById("mensaje");
const sendButton = document.getElementById("enviar");
const statusLine = document.getElementById("estado");
const welcome = document.getElementById("bienvenida");

let sessionId = null;
let busy = false;

// --- Markdown mínimo (escapa HTML primero, así no se inyecta nada) ---

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

function splitRow(line) {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

const isNumber = (cell) => /^[-+]?[\d.,\s€$%]+$/.test(cell) && /\d/.test(cell);

function renderMarkdown(source) {
  const lines = source.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || "")) {
      const head = splitRow(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(splitRow(lines[i]));
      const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
      const body = rows.map((r) => "<tr>" + r.map((c) =>
        `<td${isNumber(c) ? ' class="num"' : ""}>${inline(c)}</td>`).join("") + "</tr>").join("");
      out.push(`<div class="tabla"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const listMatch = line.match(/^\s*([-*]|\d+\.)\s+/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[1]);
      const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      const items = [];
      for (; i < lines.length && pattern.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(pattern, ""))}</li>`);
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*([-*]|\d+\.)\s|\s*\|)/.test(lines[i]); i++) {
      para.push(inline(lines[i]));
    }
    if (!para.length) { para.push(inline(lines[i])); i++; }
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return out.join("");
}

// --- Interfaz ---

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

function addMessage(role, text = "") {
  welcome.hidden = true;
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (role === "user") el.textContent = text;
  chat.appendChild(el);
  scrollToBottom();
  return el;
}

function setBusy(value) {
  busy = value;
  sendButton.disabled = value;
  sendButton.textContent = value ? "…" : "Enviar";
}

function autoresize() {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

async function loadStatus() {
  try {
    const res = await fetch("/api/estado");
    const data = await res.json();
    if (!data.api_key) {
      statusLine.textContent = "Falta OPENROUTER_API_KEY en .env";
      statusLine.className = "estado mal";
    } else {
      statusLine.textContent = `Modelo: ${data.modelo}`;
      statusLine.className = "estado ok";
    }
  } catch {
    statusLine.textContent = "Servidor no disponible";
    statusLine.className = "estado mal";
  }
}

// Lee un flujo SSE de una petición POST (EventSource solo admite GET).
async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      yield { event, data: data ? JSON.parse(data) : {} };
    }
  }
}

async function ask(question) {
  if (busy) return;
  setBusy(true);
  addMessage("user", question);

  const bubble = addMessage("bot");
  bubble.classList.add("escribiendo");
  const queries = [];
  let text = "";

  const render = () => {
    let html = "";
    if (queries.length) {
      const items = queries.map((q) => `<pre><code>${escapeHtml(q)}</code></pre>`).join("");
      html += `<details class="consultas"><summary>${queries.length} consulta${queries.length > 1 ? "s" : ""} SQL</summary>${items}</details>`;
    }
    html += renderMarkdown(text);
    bubble.innerHTML = html;
    scrollToBottom();
  };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, session_id: sessionId }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || `Error HTTP ${res.status}`);
    }
    for await (const { event, data } of readEvents(res)) {
      if (event === "session") sessionId = data.id;
      else if (event === "delta") { text += data.text; render(); }
      else if (event === "tool" && data.sql) { queries.push(data.sql); render(); }
      else if (event === "error") throw new Error(data.message);
    }
    if (!text) throw new Error("El agente no devolvió texto");
  } catch (err) {
    if (!text) bubble.classList.add("error");
    text += `${text ? "\n\n" : ""}⚠️ ${err.message}`;
    render();
  } finally {
    bubble.classList.remove("escribiendo");
    setBusy(false);
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question || busy) return;
  input.value = "";
  autoresize();
  ask(question);
});

input.addEventListener("input", autoresize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

document.querySelectorAll(".sugerencias button").forEach((btn) => {
  btn.addEventListener("click", () => ask(btn.textContent));
});

document.getElementById("nueva").addEventListener("click", () => {
  if (busy) return;
  if (sessionId) fetch(`/api/sesiones/${sessionId}`, { method: "DELETE" }).catch(() => {});
  sessionId = null;
  chat.querySelectorAll(".msg").forEach((el) => el.remove());
  welcome.hidden = false;
  input.focus();
});

loadStatus();
input.focus();
