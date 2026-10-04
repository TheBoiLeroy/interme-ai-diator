import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The MCP Apps view: one self-contained HTML document the host renders in a
 * sandboxed iframe. It shows whichever screen the tool result describes
 * (`structuredContent.view`) and calls tools back through the host for
 * navigation and votes. The ext-apps bridge is inlined (no CDN), exposed as
 * `globalThis.McpApps` because an inline script can't `import` from itself.
 */

let cached: string | null = null;

function bridgeScript() {
  const file = path.join(process.cwd(), "node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js");
  const source = readFileSync(file, "utf8");
  const exportAt = source.lastIndexOf("export{");
  const names = source
    .slice(exportAt + "export{".length, source.indexOf("}", exportAt))
    .split(",")
    .map((pair) => {
      const [local, exported = local] = pair.split(" as ").map((s) => s.trim());
      return `${JSON.stringify(exported)}:${local}`;
    });
  return `${source.slice(0, exportAt)}globalThis.McpApps={${names.join(",")}};`;
}

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 12px;
  font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  font-size: var(--font-text-sm-size, 14px);
  color: var(--color-text-primary, #18181b);
  background: var(--color-background-primary, transparent);
}
h1 { font-size: var(--font-heading-sm-size, 17px); margin: 0; font-weight: var(--font-weight-semibold, 600); }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--color-text-secondary, #71717a); margin: 16px 0 6px; font-weight: 600; }
.muted { color: var(--color-text-secondary, #71717a); font-size: 12px; }
.row { display: flex; align-items: center; gap: 8px; }
.between { justify-content: space-between; }
.wrap { flex-wrap: wrap; }
.card {
  border: 1px solid var(--color-border-primary, rgba(127,127,127,.25));
  border-radius: var(--border-radius-md, 8px); padding: 10px 12px;
  background: var(--color-background-secondary, transparent);
}
.list { display: flex; flex-direction: column; gap: 6px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px; }
button.card { text-align: left; cursor: pointer; font: inherit; color: inherit; width: 100%; }
button.card:hover { border-color: var(--color-border-info, #6366f1); }
.title { font-weight: var(--font-weight-medium, 500); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.btn {
  font: inherit; font-size: 13px; cursor: pointer; padding: 6px 12px;
  border-radius: var(--border-radius-sm, 6px);
  border: 1px solid var(--color-border-primary, rgba(127,127,127,.35));
  background: var(--color-background-primary, transparent); color: inherit;
}
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--color-background-inverse, #18181b); color: var(--color-text-inverse, #fff); border-color: transparent; }
.btn.danger { color: var(--color-text-danger, #dc2626); }
.link { background: none; border: 0; padding: 0; font: inherit; font-size: 12px; color: var(--color-text-info, #4f46e5); cursor: pointer; }
.pill { font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 999px; white-space: nowrap; }
.fmt { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; text-transform: uppercase; padding: 1px 5px; border-radius: 4px; border: 1px solid; white-space: nowrap; }
.fmt-sql { color: #7c3aed; border-color: #7c3aed55; background: #7c3aed14; }
.fmt-markdown { color: #2563eb; border-color: #2563eb55; background: #2563eb14; }
.fmt-json { color: #ea580c; border-color: #ea580c55; background: #ea580c14; }
.fmt-text { color: var(--color-text-secondary, #71717a); border-color: currentColor; }
.s-open, .review { background: #f59e0b26; color: #b45309; }
.s-accepted { background: #10b98126; color: #047857; }
.s-rejected { background: #ef444426; color: #b91c1c; }
.s-needs_rebase { background: #0ea5e926; color: #0369a1; }
.s-closed { background: #71717a26; color: #52525b; }
@media (prefers-color-scheme: dark) {
  .s-open, .review { color: #fcd34d; } .s-accepted { color: #6ee7b7; } .s-rejected { color: #fca5a5; }
  .s-needs_rebase { color: #7dd3fc; } .s-closed { color: #a1a1aa; }
  .fmt-sql { color: #c4b5fd; } .fmt-markdown { color: #93c5fd; } .fmt-json { color: #fdba74; }
}
[data-theme="dark"] .s-open, [data-theme="dark"] .review { color: #fcd34d; }
pre {
  margin: 0; padding: 10px; overflow: auto; max-height: 360px; white-space: pre;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; line-height: 1.5;
  border-radius: var(--border-radius-sm, 6px); background: var(--color-background-tertiary, rgba(127,127,127,.08));
}
.add { background: #10b9811f; color: #047857; display: block; }
.del { background: #ef44441f; color: #b91c1c; display: block; }
.hunk { color: var(--color-text-secondary, #71717a); display: block; }
@media (prefers-color-scheme: dark) { .add { color: #6ee7b7; } .del { color: #fca5a5; } }
textarea { width: 100%; font: inherit; padding: 8px; border-radius: 6px; border: 1px solid var(--color-border-primary, rgba(127,127,127,.35)); background: transparent; color: inherit; min-height: 60px; }
.summary { white-space: pre-wrap; line-height: 1.5; }
input { flex: 1; min-width: 0; font: inherit; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--color-border-primary, rgba(127,127,127,.35)); background: transparent; color: inherit; }
.mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
.nav { margin-bottom: 8px; gap: 12px; }
.btn.small { padding: 4px 10px; font-size: 12px; }
.tabs { gap: 4px; margin-bottom: 6px; }
.tab { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer; border: 1px solid var(--color-border-primary, rgba(127,127,127,.35)); background: transparent; color: var(--color-text-secondary, #71717a); }
.tab.active { background: var(--color-background-inverse, #18181b); color: var(--color-text-inverse, #fff); border-color: transparent; }
.composer textarea { min-height: 44px; }
.card.current { border-color: var(--color-border-info, #6366f1); }
.flash { margin: 0 0 8px; padding: 6px 10px; border-radius: 6px; background: var(--color-background-success, #10b9811f); font-size: 12px; }
.flash.error { background: var(--color-background-danger, #ef44441f); }
.error { color: var(--color-text-danger, #dc2626); }
`;

const SCRIPT = String.raw`
const { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } = globalThis.McpApps;
const app = new App({ name: "Intermediary", version: "1.1.0" });
const root = document.getElementById("root");

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const STATUS = { open: "In review", accepted: "Accepted", rejected: "Rejected", needs_rebase: "Needs rebase", closed: "Closed" };
const status = (s) => h("span", { class: "pill s-" + s }, STATUS[s] || s);
const fmt = (f) => h("span", { class: "fmt fmt-" + f }, f);
const ago = (iso) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now"; const m = Math.round(s / 60); if (m < 60) return m + "m ago";
  const hr = Math.round(m / 60); return hr < 24 ? hr + "h ago" : Math.round(hr / 24) + "d ago";
};
const link = (text, onclick) => h("button", { class: "link", onclick }, text);
const openApp = (url) => link("Open in web app ↗", () => app.openLink({ url }).catch(() => {}));
const nav = (...items) => h("div", { class: "row wrap nav" }, items.filter(Boolean));

function show(...nodes) { root.replaceChildren(...nodes); }
function loading(text) { show(h("p", { class: "muted" }, text || "Loading…")); }
function flash(text, isError) {
  const el = h("p", { class: isError ? "error flash" : "flash" }, text);
  root.prepend(el);
  setTimeout(() => el.remove(), 4000);
}

/** Calls a tool and re-renders from its result. Inline errors keep the current screen. */
async function call(name, args, loadingText, { keepScreen } = {}) {
  if (!keepScreen) loading(loadingText);
  try {
    const res = await app.callServerTool({ name, arguments: args });
    if (res.isError && keepScreen) {
      flash((res.content || []).map((c) => c.text || "").join(" ") || "That didn't work.", true);
      return res;
    }
    handle(res);
    return res;
  } catch (e) {
    show(h("p", { class: "error" }, String((e && e.message) || e)));
  }
}

/** Puts a request in the chat so Claude does the work (edit, revise, rebase, draft). */
async function askClaude(text, note) {
  try {
    await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    flash(note || "Sent to Claude.");
  } catch (e) {
    flash("Couldn't send to the chat: " + ((e && e.message) || e), true);
  }
}
function tellModel(text) {
  app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {});
}

/** A small "ask Claude" box: free text plus a prepared prompt. */
function composer(placeholder, buttonText, toPrompt) {
  const input = h("textarea", { placeholder, rows: "2" });
  const send = () => {
    const text = input.value.trim();
    if (!text) return input.focus();
    askClaude(toPrompt(text));
    input.value = "";
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); });
  return h("div", { class: "card composer" }, input, h("div", { class: "row", style: "margin-top:6px" },
    h("button", { class: "btn primary", onclick: send }, buttonText),
    h("span", { class: "muted" }, "Claude does it in this chat")));
}

/** Two-step button for anything destructive (iframes often can't show confirm()). */
function confirmButton(text, confirmText, onConfirm) {
  const btn = h("button", { class: "btn danger small" }, text);
  let armed = false;
  btn.addEventListener("click", () => {
    if (!armed) { armed = true; btn.textContent = confirmText; setTimeout(() => { armed = false; btn.textContent = text; }, 4000); return; }
    onConfirm();
  });
  return btn;
}

function handle(res) {
  if (!res) return;
  const data = res.structuredContent;
  if (res.isError || !data) {
    const text = (res.content || []).map((c) => c.text || "").join("\n");
    show(h("p", { class: res.isError ? "error" : "" }, text || "Nothing to show."),
      nav(link("← Your workspaces", () => call("list_workspaces", {}))));
    return;
  }
  const render = { home: renderHome, workspace: renderWorkspace, members: renderMembers, proposal: renderProposal, artifact: renderArtifact }[data.view];
  if (render) render(data);
}

// ---------------------------------------------------------------------------

function renderHome(d) {
  const name = h("input", { placeholder: "e.g. Database team", maxlength: "80" });
  const inviteLink = h("input", { placeholder: "Paste an invite link" });
  show(
    h("div", { class: "row between wrap" }, h("div", null, h("h1", null, "Your workspaces"), h("div", { class: "muted" }, d.me)), openApp(d.appUrl)),
    d.invitations.length ? [h("h2", null, "Invitations"), h("div", { class: "list" }, d.invitations.map((i) =>
      h("div", { class: "card row between" }, h("span", null, "You're invited to ", h("strong", null, i.workspaceName)),
        h("button", { class: "btn primary small", onclick: () => call("join_workspace", { invitation_id: i.id }, "Joining…") }, "Join"))))] : null,
    h("h2", null, "Workspaces"),
    d.workspaces.length
      ? h("div", { class: "list" }, d.workspaces.map((w) =>
          h("button", { class: "card row between", onclick: () => call("show_workspace", { workspace_id: w.id }) },
            h("span", { class: "title" }, w.name), w.isCreator ? h("span", { class: "muted" }, "creator") : null)))
      : h("p", { class: "muted" }, "None yet. Create one, or join with an invite link."),
    h("h2", null, "New workspace"),
    h("div", { class: "row" }, name, h("button", { class: "btn primary", onclick: () => {
      if (!name.value.trim()) return name.focus();
      call("create_workspace", { name: name.value.trim() }, "Creating…");
    } }, "Create")),
    h("h2", null, "Join with a link"),
    h("div", { class: "row" }, inviteLink, h("button", { class: "btn", onclick: () => {
      if (!inviteLink.value.trim()) return inviteLink.focus();
      call("join_workspace", { invite_link: inviteLink.value.trim() }, "Joining…");
    } }, "Join")));
}

function renderWorkspace(d) {
  const waiting = d.proposals.filter((p) => p.needsMyVote);
  const mine = d.proposals.filter((p) => p.isMine && p.status !== "open");
  const others = d.proposals.filter((p) => !p.needsMyVote && !mine.includes(p));
  const proposalRow = (p) => h("button", { class: "card row between", onclick: () => call("review_proposal", { proposal_id: p.id }) },
    h("div", { style: "min-width:0" },
      h("div", { class: "title" }, p.artifactTitle),
      h("div", { class: "muted title" }, p.author + " · " + ago(p.updatedAt) + (p.summary ? " · " + p.summary : ""))),
    h("div", { class: "row" },
      p.status === "open" ? h("span", { class: "muted" }, p.approvals + "/" + p.needed) : null,
      status(p.status)));
  show(
    nav(link("← Your workspaces", () => call("list_workspaces", {}))),
    h("div", { class: "row between wrap" },
      h("div", null, h("h1", null, d.workspace.name), h("div", { class: "muted" }, d.members.map((m) => m.isMe ? m.name + " (you)" : m.name).join(" · "))),
      h("div", { class: "row" },
        h("button", { class: "btn small", onclick: () => call("show_members", { workspace_id: d.workspace.id }) }, "Members & invites"),
        link("↻", () => call("show_workspace", { workspace_id: d.workspace.id }, "Refreshing…")))),
    waiting.length ? [h("h2", null, "Waiting on your vote"), h("div", { class: "list" }, waiting.map(proposalRow))] : null,
    mine.length ? [h("h2", null, "Your proposals that need you"), h("div", { class: "list" }, mine.map(proposalRow))] : null,
    others.length ? [h("h2", null, "In flight"), h("div", { class: "list" }, others.map(proposalRow))] : null,
    h("h2", null, "Artifacts"),
    d.artifacts.length
      ? h("div", { class: "grid" }, d.artifacts.map((a) =>
          h("button", { class: "card", onclick: () => call("get_artifact", { artifact_id: a.id }) },
            h("div", { class: "row between" }, h("span", { class: "title" }, a.title),
              h("span", { class: "row" }, a.needsMyReview ? h("span", { class: "pill review" }, "Needs your review") : null, fmt(a.format))),
            h("div", { class: "muted" }, "Updated " + ago(a.updatedAt)))))
      : h("p", { class: "muted" }, "Nothing published yet."),
    h("h2", null, "Create something new"),
    composer("What should Claude draft for the team? e.g. a SQL schema for orders", "Ask Claude",
      (t) => "Draft this for my Intermediary workspace \"" + d.workspace.name + "\" (workspace_id " + d.workspace.id + "): " + t +
        "\nShow me the draft first; when I'm happy, publish it with publish_artifact."));
}

function renderMembers(d) {
  const email = h("input", { type: "email", placeholder: "teammate@example.com" });
  const linkBox = d.inviteLink ? h("input", { readonly: true, value: d.inviteLink, class: "mono" }) : null;
  if (linkBox) linkBox.addEventListener("focus", () => linkBox.select());
  const copy = async () => {
    try { await navigator.clipboard.writeText(d.inviteLink); flash("Invite link copied."); }
    catch { linkBox.focus(); linkBox.select(); flash("Press ⌘C / Ctrl+C to copy."); }
  };
  const ws = d.workspace.id;
  show(
    nav(link("← " + d.workspace.name, () => call("show_workspace", { workspace_id: ws })), link("All workspaces", () => call("list_workspaces", {}))),
    h("div", { class: "row between wrap" }, h("h1", null, "Members & invites"), openApp(d.appUrl)),
    h("div", { class: "muted" }, d.members.length + " of 5 members"),
    h("h2", null, "Members"),
    h("div", { class: "list" }, d.members.map((m) =>
      h("div", { class: "card row between" },
        h("div", { style: "min-width:0" }, h("div", { class: "title" }, m.name + (m.isMe ? " (you)" : "")), h("div", { class: "muted title" }, m.email)),
        m.isCreator ? h("span", { class: "muted" }, "creator")
          : d.isCreator ? confirmButton("Remove", "Confirm remove", async () => {
              const res = await call("remove_member", { workspace_id: ws, user_id: m.id }, "Removing…");
              if (res && !res.isError) tellModel("The user removed " + m.name + " from " + d.workspace.name + ".");
            }) : null))),
    d.invites.length ? [h("h2", null, "Pending email invites"), h("div", { class: "list" }, d.invites.map((i) =>
      h("div", { class: "card row between" }, h("span", { class: "muted" }, i.email + " · invited"),
        d.isCreator ? h("button", { class: "btn small", onclick: () => call("revoke_invite", { workspace_id: ws, invite_id: i.id }, "Revoking…") }, "Revoke") : null)))] : null,
    d.isCreator ? [
      h("h2", null, "Invite link"),
      d.full ? h("p", { class: "muted" }, "This workspace is full.") : [
        h("div", { class: "row" }, linkBox, h("button", { class: "btn primary", onclick: copy }, "Copy")),
        h("div", { class: "muted", style: "margin-top:4px" }, "Anyone with this link can sign in and join."),
      ],
      h("div", { style: "margin-top:6px" }, confirmButton("Reset link", "Old link stops working — confirm", () => call("reset_invite_link", { workspace_id: ws }, "Resetting…"))),
      h("h2", null, "Invite by email"),
      d.seatsLeft > 0 ? h("div", { class: "row" }, email, h("button", { class: "btn", onclick: () => {
        if (!email.value.trim()) return email.focus();
        call("invite_member", { workspace_id: ws, email: email.value.trim() }, "Inviting…", { keepScreen: true });
      } }, "Invite")) : h("p", { class: "muted" }, "No seats left (5 people, including pending invites)."),
      h("div", { class: "muted", style: "margin-top:4px" }, "They see it after signing in with that email. No email is sent, so share the link too."),
    ] : h("p", { class: "muted" }, "Only the person who created the workspace can invite or remove people."));
}

function diffView(diff) {
  const lines = diff.split("\n").filter((l) => !l.startsWith("===") && !l.startsWith("Index:") && !l.startsWith("---") && !l.startsWith("+++"));
  return h("pre", null, lines.map((l) =>
    h("span", { class: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "" }, l + "\n")));
}

function tabs(items) {
  const body = h("div");
  const buttons = items.map(([label, render], i) => h("button", { class: "tab", onclick: () => select(i) }, label));
  function select(i) { buttons.forEach((b, j) => b.classList.toggle("active", i === j)); body.replaceChildren(items[i][1]()); }
  select(0);
  return [h("div", { class: "row tabs" }, buttons), body];
}

function renderProposal(d) {
  const p = d.proposal;
  const canVote = !p.isAuthor && p.status === "open";
  let comment;
  const vote = async (v) => {
    const text = comment ? comment.value.trim() : "";
    if (v === "reject" && !text) { comment.focus(); comment.placeholder = "Say why you're rejecting (required)"; return; }
    const res = await call("cast_review", { proposal_id: p.id, vote: v, comment: text }, v === "approve" ? "Approving…" : "Rejecting…");
    if (res && !res.isError) tellModel("The user " + (v === "approve" ? "approved" : "rejected") + " the proposal to " + p.artifactTitle + " (" + p.id + ") from the review view.");
  };
  const rejections = p.reviewers.filter((r) => r.vote === "reject" && r.comment).map((r) => r.name + ": " + r.comment);
  show(
    nav(link("← Workspace", () => call("show_workspace", { workspace_id: d.workspaceId })),
      link(p.artifactTitle, () => call("get_artifact", { artifact_id: p.artifactId }))),
    h("div", { class: "row between wrap" },
      h("div", null,
        h("div", { class: "row" }, h("h1", null, p.artifactTitle), fmt(p.format), status(p.status)),
        h("div", { class: "muted" }, "Proposed by " + p.author + " · revision " + p.revision + " · " + ago(p.updatedAt))),
      openApp(d.appUrl)),
    h("h2", null, "Summary"), h("div", { class: "summary" }, p.summary),
    h("h2", null, "Proposed version"),
    tabs([["Changes", () => diffView(p.diff)], ["Full content", () => h("pre", null, p.content)]]),
    h("h2", null, "Votes"),
    h("div", { class: "list" }, p.reviewers.length ? p.reviewers.map((r) =>
      h("div", { class: "row between" }, h("span", null, r.name),
        h("span", { class: "muted" }, r.vote ? (r.vote === "approve" ? "✓ approved" : "✕ rejected") + (r.comment ? " — " + r.comment : "") : "waiting"))) : h("span", { class: "muted" }, "No other members.")),
    canVote ? h("div", { class: "card", style: "margin-top:12px" },
      h("div", { style: "margin-bottom:8px" }, p.myVote ? "You voted " + p.myVote + ". You can change your vote." : "Your vote"),
      (comment = h("textarea", { placeholder: "Comment (required to reject)" })),
      h("div", { class: "row", style: "margin-top:8px" },
        h("button", { class: "btn primary", onclick: () => vote("approve") }, "Approve"),
        h("button", { class: "btn danger", onclick: () => vote("reject") }, "Reject"),
        h("button", { class: "btn", onclick: () => askClaude("Review proposal " + p.id + " to \"" + p.artifactTitle + "\" for me: call review_proposal, then tell me what changed, any risks, and whether you'd approve. Don't vote.") }, "Ask Claude's opinion"))) : null,
    p.isAuthor && p.status === "rejected" ? h("div", { class: "card", style: "margin-top:12px" },
      h("div", { style: "margin-bottom:8px" }, "Your proposal was rejected" + (rejections.length ? ": " + rejections.join("; ") : ".")),
      h("button", { class: "btn primary", onclick: () => askClaude("My Intermediary proposal " + p.id + " to \"" + p.artifactTitle + "\" (artifact_id " + p.artifactId + ") was rejected. Feedback: " + (rejections.join("; ") || "none given") + ". Revise it to address the feedback: get_artifact, update the content, then propose_change with a summary of what you changed.") }, "Ask Claude to revise")) : null,
    p.isAuthor && p.status === "needs_rebase" ? h("div", { class: "card", style: "margin-top:12px" },
      h("div", { style: "margin-bottom:8px" }, "The official version changed since you proposed this."),
      h("button", { class: "btn primary", onclick: () => askClaude("Rebase my Intermediary proposal " + p.id + " to \"" + p.artifactTitle + "\" (artifact_id " + p.artifactId + "): review_proposal to see my change, get_artifact for the new official version, re-apply my change on top of it, then propose_change.") }, "Ask Claude to rebase")) : null,
    p.isAuthor && p.status === "open" ? h("p", { class: "muted" }, "You wrote this proposal; your teammates review it.") : null);
}

function renderArtifact(d) {
  const a = d.artifact;
  show(
    nav(link("← Workspace", () => call("show_workspace", { workspace_id: a.workspaceId }))),
    h("div", { class: "row between wrap" },
      h("div", null,
        h("div", { class: "row" }, h("h1", null, a.title), fmt(a.format)),
        h("div", { class: "muted" }, (a.isCurrent ? "Official" : "Older official") + " v" + a.version + " by " + a.author + " · " + ago(a.createdAt))),
      openApp(d.appUrl)),
    !a.isCurrent ? h("div", { class: "card", style: "margin-top:8px" }, "You're viewing an older version. ",
      link("See current", () => call("get_artifact", { artifact_id: a.id }))) : null,
    d.proposals.length ? [h("h2", null, "Open proposals"), h("div", { class: "list" }, d.proposals.map((p) =>
      h("button", { class: "card row between", onclick: () => call("review_proposal", { proposal_id: p.id }) },
        h("span", { class: "title" }, p.author + (p.isMine ? " (you)" : "") + (p.summary ? " · " + p.summary : "")), status(p.status))))] : null,
    a.summary ? [h("h2", null, "Summary"), h("div", { class: "summary" }, a.summary)] : null,
    h("h2", null, "Content"), h("pre", null, a.content),
    a.isCurrent ? [h("h2", null, "Change it"),
      composer("What should change? e.g. add an index on email", "Ask Claude",
        (t) => "Change the Intermediary artifact \"" + a.title + "\" (artifact_id " + a.id + "): " + t +
          "\nUse get_artifact for the current official version, show me the edit, and when I agree send it with propose_change.")] : null,
    d.versions.length > 1 ? [h("h2", null, "History"), h("div", { class: "list" }, d.versions.map((v) =>
      h("button", { class: "card row between" + (v.number === a.version ? " current" : ""), onclick: () => call("get_artifact", { artifact_id: a.id, version: v.number }) },
        h("span", null, "v" + v.number + " · " + v.author), h("span", { class: "muted" }, (v.isCurrent ? "current · " : "") + ago(v.createdAt)))))] : null);
}

function applyContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles && ctx.styles.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles && ctx.styles.css && ctx.styles.css.fonts) applyHostFonts(ctx.styles.css.fonts);
}

app.ontoolinput = () => loading();
app.ontoolresult = (res) => handle(res);
app.ontoolcancelled = () => show(h("p", { class: "muted" }, "Cancelled."));
app.onhostcontextchanged = (ctx) => applyContext(ctx);
loading();
app.connect().then(() => applyContext(app.getHostContext())).catch((e) => show(h("p", { class: "error" }, "Couldn't connect to the host: " + e)));
`;

export function viewHtml() {
  if (cached) return cached;
  // "</script" inside the inlined source would end the tag early.
  const bridge = bridgeScript().replace(/<\/script/gi, "<\\/script");
  cached = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Intermediary</title>
<style>${STYLES}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${bridge}</script>
<script type="module">${SCRIPT}</script>
</body>
</html>`;
  return cached;
}
