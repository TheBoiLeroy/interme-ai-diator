import "server-only";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as z from "zod/v4";
import { makeDiff } from "@/lib/artifacts";
import {
  displayName,
  FORMATS,
  type Artifact,
  type ArtifactVersion,
  type Profile,
  type Proposal,
  type Review,
  type Workspace,
} from "@/lib/types";
import type { McpUser } from "./auth";
import { viewHtml } from "./view";

export const VIEW_URI = "ui://intermediary/view.html";
const ui = { ui: { resourceUri: VIEW_URI } };

type Ctx = { supabase: SupabaseClient; user: McpUser; appUrl: string };

class UserError extends Error {}

/** Tool results: text the model reads, plus structured data the view renders. */
function result(text: string, structured?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], ...(structured ? { structuredContent: structured } : {}) };
}

function guard<A>(fn: (args: A) => Promise<ReturnType<typeof result>>) {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      const message = e instanceof UserError || e instanceof Error ? e.message : "Something went wrong";
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  };
}

// ---------------------------------------------------------------------------
// Data access (as the signed-in user; RLS decides what's visible)
// ---------------------------------------------------------------------------

async function myWorkspaces({ supabase, user }: Ctx) {
  const { data } = await supabase
    .from("workspace_members")
    .select("workspaces(id, name, created_by, created_at)")
    .eq("user_id", user.id)
    .returns<{ workspaces: Workspace }[]>();
  return (data ?? []).map((r) => r.workspaces);
}

async function resolveWorkspace(ctx: Ctx, workspaceId?: string) {
  const all = await myWorkspaces(ctx);
  if (workspaceId) {
    const ws = all.find((w) => w.id === workspaceId);
    if (!ws) throw new UserError("Workspace not found, or you're not a member.");
    return ws;
  }
  if (all.length === 1) return all[0];
  if (!all.length) throw new UserError("You're not in any workspace yet. Create one in the Intermediary web app.");
  throw new UserError(
    `You're in several workspaces; pass workspace_id. ${all.map((w) => `${w.name} (${w.id})`).join(", ")}`,
  );
}

async function membersOf({ supabase }: Ctx, wsId: string) {
  const { data } = await supabase
    .from("workspace_members")
    .select("profiles(id, email, display_name)")
    .eq("workspace_id", wsId)
    .returns<{ profiles: Profile }[]>();
  return (data ?? []).map((r) => r.profiles);
}

async function proposalView(ctx: Ctx, proposalId: string) {
  const { supabase, user } = ctx;
  const { data: p } = await supabase.from("proposals").select("*").eq("id", proposalId).maybeSingle<Proposal>();
  if (!p) throw new UserError("Proposal not found.");
  const [{ data: artifact }, { data: reviews }, members, { data: proposed }] = await Promise.all([
    supabase.from("artifacts").select("*").eq("id", p.artifact_id).single<Artifact>(),
    supabase.from("reviews").select("*").eq("proposal_id", p.id).eq("revision", p.revision).returns<Review[]>(),
    membersOf(ctx, p.workspace_id),
    supabase
      .from("artifact_versions")
      .select("content")
      .eq("id", p.proposed_version_id)
      .maybeSingle<Pick<ArtifactVersion, "content">>(),
  ]);
  const people = new Map(members.map((m) => [m.id, m]));
  const reviewers = members.filter((m) => m.id !== p.author_id);
  const voteOf = new Map((reviews ?? []).map((r) => [r.reviewer_id, r]));
  return {
    view: "proposal",
    appUrl: `${ctx.appUrl}/w/${p.workspace_id}/p/${p.id}`,
    workspaceId: p.workspace_id,
    proposal: {
      id: p.id,
      status: p.status,
      revision: p.revision,
      summary: p.summary,
      diff: p.diff,
      content: proposed?.content ?? "",
      artifactId: p.artifact_id,
      updatedAt: p.updated_at,
      artifactTitle: artifact?.title ?? "Artifact",
      format: artifact?.format ?? "text",
      author: displayName(people.get(p.author_id)),
      isAuthor: p.author_id === user.id,
      myVote: voteOf.get(user.id)?.vote ?? null,
      reviewers: reviewers.map((m) => ({
        name: displayName(m),
        vote: voteOf.get(m.id)?.vote ?? null,
        comment: voteOf.get(m.id)?.comment ?? "",
      })),
    },
  };
}

function proposalText(v: Awaited<ReturnType<typeof proposalView>>) {
  const p = v.proposal;
  const votes = p.reviewers.map((r) => `${r.name}: ${r.vote ?? "waiting"}${r.comment ? ` ("${r.comment}")` : ""}`);
  return [
    `Proposal ${p.id} to "${p.artifactTitle}" by ${p.author} — status: ${p.status} (revision ${p.revision}).`,
    p.isAuthor ? "You wrote this proposal." : p.myVote ? `You voted: ${p.myVote}.` : "It's waiting on your vote.",
    `Votes: ${votes.join("; ") || "no other members"}`,
    `Summary:\n${p.summary}`,
    `Diff:\n${p.diff}`,
  ].join("\n\n");
}

async function artifactView(ctx: Ctx, artifactId: string, versionNumber?: number) {
  const { supabase } = ctx;
  const { data: artifact } = await supabase.from("artifacts").select("*").eq("id", artifactId).maybeSingle<Artifact>();
  if (!artifact?.current_version_id) throw new UserError("Artifact not found.");
  const [{ data: versions }, { data: proposals }, members] = await Promise.all([
    supabase
      .from("artifact_versions")
      .select("*")
      .eq("artifact_id", artifact.id)
      .eq("is_official", true)
      .order("version_number", { ascending: false })
      .returns<ArtifactVersion[]>(),
    supabase
      .from("proposals")
      .select("id, author_id, status, summary, updated_at")
      .eq("artifact_id", artifact.id)
      .in("status", ["open", "rejected", "needs_rebase"])
      .order("updated_at", { ascending: false })
      .returns<Pick<Proposal, "id" | "author_id" | "status" | "summary" | "updated_at">[]>(),
    membersOf(ctx, artifact.workspace_id),
  ]);
  const people = new Map(members.map((m) => [m.id, m]));
  const version =
    versionNumber != null
      ? versions?.find((v) => v.version_number === versionNumber)
      : versions?.find((v) => v.id === artifact.current_version_id);
  if (!version) throw new UserError(`Official version ${versionNumber} not found.`);
  return {
    view: "artifact",
    appUrl: `${ctx.appUrl}/w/${artifact.workspace_id}/a/${artifact.id}`,
    artifact: {
      id: artifact.id,
      workspaceId: artifact.workspace_id,
      title: artifact.title,
      format: artifact.format,
      version: version.version_number,
      isCurrent: version.id === artifact.current_version_id,
      content: version.content,
      summary: version.summary,
      author: displayName(people.get(version.author_id)),
      createdAt: version.created_at,
    },
    versions: (versions ?? []).map((v) => ({
      number: v.version_number,
      author: displayName(people.get(v.author_id)),
      createdAt: v.created_at,
      isCurrent: v.id === artifact.current_version_id,
    })),
    proposals: (proposals ?? []).map((p) => ({
      id: p.id,
      author: displayName(people.get(p.author_id)),
      isMine: p.author_id === ctx.user.id,
      status: p.status,
      summary: p.summary.split("\n")[0],
      updatedAt: p.updated_at,
    })),
  };
}

async function workspaceView(ctx: Ctx, workspaceId?: string) {
  const { supabase, user } = ctx;
  const ws = await resolveWorkspace(ctx, workspaceId);
  const [members, { data: artifacts }, { data: proposals }] = await Promise.all([
    membersOf(ctx, ws.id),
    supabase
      .from("artifacts")
      .select("*")
      .eq("workspace_id", ws.id)
      .order("updated_at", { ascending: false })
      .returns<Artifact[]>(),
    supabase
      .from("proposals")
      .select("*")
      .eq("workspace_id", ws.id)
      .in("status", ["open", "rejected", "needs_rebase"])
      .order("updated_at", { ascending: false })
      .returns<Proposal[]>(),
  ]);
  const { data: reviews } = await supabase
    .from("reviews")
    .select("*")
    .in("proposal_id", (proposals ?? []).map((p) => p.id))
    .returns<Review[]>();
  const people = new Map(members.map((m) => [m.id, m]));
  const titleOf = new Map((artifacts ?? []).map((a) => [a.id, a.title]));
  const votesOn = (p: Proposal) => (reviews ?? []).filter((r) => r.proposal_id === p.id && r.revision === p.revision);
  const needsMe = (p: Proposal) =>
    p.status === "open" && p.author_id !== user.id && !votesOn(p).some((r) => r.reviewer_id === user.id);

  const openProposals = (proposals ?? []).map((p) => ({
    id: p.id,
    artifactId: p.artifact_id,
    artifactTitle: titleOf.get(p.artifact_id) ?? "Artifact",
    author: displayName(people.get(p.author_id)),
    status: p.status,
    summary: p.summary.split("\n")[0],
    approvals: votesOn(p).filter((r) => r.vote === "approve" && r.reviewer_id !== p.author_id).length,
    needed: Math.max(members.length - 1, 0),
    needsMyVote: needsMe(p),
    isMine: p.author_id === user.id,
    updatedAt: p.updated_at,
  }));
  const awaiting = new Set(openProposals.filter((p) => p.needsMyVote).map((p) => p.artifactId));

  return {
    view: "workspace",
    appUrl: `${ctx.appUrl}/w/${ws.id}`,
    workspace: { id: ws.id, name: ws.name },
    members: members.map((m) => ({ name: displayName(m), isMe: m.id === user.id })),
    artifacts: (artifacts ?? []).map((a) => ({
      id: a.id,
      title: a.title,
      format: a.format,
      updatedAt: a.updated_at,
      needsMyReview: awaiting.has(a.id),
    })),
    proposals: openProposals,
  };
}

function workspaceText(v: Awaited<ReturnType<typeof workspaceView>>) {
  const lines = [
    `Workspace "${v.workspace.name}" (${v.workspace.id}). Members: ${v.members.map((m) => m.name).join(", ")}.`,
    "Artifacts:",
    ...v.artifacts.map((a) => `- ${a.title} [${a.format}] id=${a.id}${a.needsMyReview ? " — needs your review" : ""}`),
    v.proposals.length ? "Open proposals:" : "No open proposals.",
    ...v.proposals.map(
      (p) =>
        `- ${p.artifactTitle} by ${p.author}: ${p.status}, ${p.approvals}/${p.needed} approvals${p.needsMyVote ? ", WAITING ON YOU" : ""} id=${p.id}`,
    ),
  ];
  return lines.join("\n");
}

async function homeView(ctx: Ctx) {
  const { supabase, user } = ctx;
  const [all, { data }] = await Promise.all([myWorkspaces(ctx), supabase.rpc("my_invitations")]);
  const invites = data as { id: string; workspace_name: string }[] | null;
  return {
    view: "home",
    appUrl: `${ctx.appUrl}/workspaces`,
    me: user.email,
    workspaces: all.map((w) => ({ id: w.id, name: w.name, isCreator: w.created_by === user.id })),
    invitations: (invites ?? []).map((i) => ({ id: i.id, workspaceName: i.workspace_name })),
  };
}

function homeText(v: Awaited<ReturnType<typeof homeView>>) {
  return [
    v.workspaces.length
      ? `Your workspaces:\n${v.workspaces.map((w) => `- ${w.name} (id ${w.id})${w.isCreator ? " — you created it" : ""}`).join("\n")}`
      : "You're not in any workspace yet.",
    v.invitations.length
      ? `Pending invitations:\n${v.invitations.map((i) => `- ${i.workspaceName} (invitation_id ${i.id})`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function membersView(ctx: Ctx, workspaceId?: string) {
  const { supabase, user } = ctx;
  const ws = await resolveWorkspace(ctx, workspaceId);
  const isCreator = ws.created_by === user.id;
  const [members, { data: invites }, link] = await Promise.all([
    membersOf(ctx, ws.id),
    supabase
      .from("workspace_invites")
      .select("id, email")
      .eq("workspace_id", ws.id)
      .is("accepted_at", null)
      .returns<{ id: string; email: string }[]>(),
    isCreator ? supabase.rpc("workspace_invite_token", { ws: ws.id }) : Promise.resolve({ data: null }),
  ]);
  return {
    view: "members",
    appUrl: `${ctx.appUrl}/w/${ws.id}/members`,
    workspace: { id: ws.id, name: ws.name },
    isCreator,
    full: members.length >= MAX_MEMBERS,
    seatsLeft: Math.max(MAX_MEMBERS - members.length - (invites?.length ?? 0), 0),
    inviteLink: link.data ? `${ctx.appUrl}/join/${link.data}` : null,
    members: members.map((m) => ({
      id: m.id,
      name: displayName(m),
      email: m.email,
      isMe: m.id === user.id,
      isCreator: m.id === ws.created_by,
    })),
    invites: invites ?? [],
  };
}

function membersText(v: Awaited<ReturnType<typeof membersView>>) {
  return [
    `Members of "${v.workspace.name}" (${v.members.length}/${MAX_MEMBERS}):`,
    ...v.members.map((m) => `- ${m.name} <${m.email}> user_id=${m.id}${m.isCreator ? " (creator)" : ""}${m.isMe ? " (you)" : ""}`),
    v.invites.length ? `Pending email invites: ${v.invites.map((i) => `${i.email} (invite_id ${i.id})`).join(", ")}` : "",
    v.inviteLink ? `Invite link (share it; anyone with it can join): ${v.inviteLink}` : "",
    v.isCreator ? "" : "Only the workspace creator can invite or remove people.",
  ]
    .filter(Boolean)
    .join("\n");
}

const MAX_MEMBERS = 5;
const TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function buildServer(ctx: Ctx) {
  const server = new McpServer(
    { name: "intermediary", version: "1.0.0" },
    {
      instructions:
        "Intermediary is a team workspace where each person works privately with their own AI, publishes artifacts " +
        "(SQL, Markdown, JSON, text), and changes them through proposals every other member must approve. " +
        "You act as the signed-in user's private AI, and the user should be able to do everything from this chat. " +
        "Start with list_workspaces (home: workspaces, invitations, create) or show_workspace. " +
        "To change an artifact: get_artifact, edit the full content, then propose_change; the same call revises a " +
        "rejected proposal or rebases one marked needs_rebase onto the current official version. To share something new: " +
        "publish_artifact. Team management: show_members, invite_member, reset_invite_link, revoke_invite, remove_member, " +
        "create_workspace, join_workspace. Never vote (cast_review) or remove anyone unless the user explicitly asks.",
    },
  );

  registerAppResource(server, "Intermediary view", VIEW_URI, { description: "Workspace, artifact and proposal views" }, async () => ({
    contents: [{ uri: VIEW_URI, mimeType: RESOURCE_MIME_TYPE, text: viewHtml() }],
  }));

  registerAppTool(
    server,
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "Show the user's Intermediary home: their workspaces, pending invitations, and a form to create a workspace.",
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    guard(async () => {
      const v = await homeView(ctx);
      return result(homeText(v), v);
    }),
  );

  registerAppTool(
    server,
    "show_workspace",
    {
      title: "Show workspace",
      description:
        "Show a workspace dashboard: its artifacts, open proposals, and which ones wait on the user's vote. " +
        "workspace_id is optional when the user is in exactly one workspace.",
      inputSchema: z.object({ workspace_id: z.string().uuid().optional() }),
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    guard(async ({ workspace_id }: { workspace_id?: string }) => {
      const v = await workspaceView(ctx, workspace_id);
      return result(workspaceText(v), v);
    }),
  );

  registerAppTool(
    server,
    "get_artifact",
    {
      title: "Get artifact",
      description:
        "Read an artifact (full content and summary), with its version history and open proposals. Defaults to the current official version; pass version for an older one.",
      inputSchema: z.object({ artifact_id: z.string().uuid(), version: z.number().int().positive().optional() }),
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    guard(async ({ artifact_id, version }: { artifact_id: string; version?: number }) => {
      const v = await artifactView(ctx, artifact_id, version);
      const a = v.artifact;
      const open = v.proposals.length
        ? `\n\nOpen proposals: ${v.proposals.map((p) => `${p.author} (${p.status}, id ${p.id})`).join("; ")}`
        : "";
      return result(
        `"${a.title}" ${a.isCurrent ? "current official" : "older official"} v${a.version} of ${v.versions.length} [${a.format}] by ${a.author}.${open}\n\nSummary:\n${a.summary}\n\nContent:\n${a.content}`,
        v,
      );
    }),
  );

  registerAppTool(
    server,
    "review_proposal",
    {
      title: "Review proposal",
      description: "Show a proposal's summary, diff and votes so the user can review it.",
      inputSchema: z.object({ proposal_id: z.string().uuid() }),
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    guard(async ({ proposal_id }: { proposal_id: string }) => {
      const v = await proposalView(ctx, proposal_id);
      return result(proposalText(v), v);
    }),
  );

  registerAppTool(
    server,
    "cast_review",
    {
      title: "Approve or reject a proposal",
      description:
        "Cast the user's vote on a proposal. Only call this when the user explicitly decides. Rejections need a comment.",
      inputSchema: z.object({
        proposal_id: z.string().uuid(),
        vote: z.enum(["approve", "reject"]),
        comment: z.string().max(2000).optional(),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
      _meta: ui,
    },
    guard(async ({ proposal_id, vote, comment }: { proposal_id: string; vote: "approve" | "reject"; comment?: string }) => {
      const { data, error } = await ctx.supabase.rpc("cast_review", {
        pid: proposal_id,
        p_vote: vote,
        p_comment: comment ?? "",
      });
      if (error) throw new UserError(error.message);
      const v = await proposalView(ctx, proposal_id);
      const outcome =
        data === "accepted"
          ? "That was the last approval: the change is now the official version."
          : data === "rejected"
            ? "Rejected. The author will revise it."
            : "Vote recorded; still waiting on others.";
      return result(`${outcome}\n\n${proposalText(v)}`, v);
    }),
  );

  registerAppTool(
    server,
    "publish_artifact",
    {
      title: "Publish artifact",
      description:
        "Publish new work to the team as an artifact. Write a short summary for reviewers. The user's chat stays private; only the artifact and summary are shared.",
      inputSchema: z.object({
        workspace_id: z.string().uuid().optional(),
        title: z.string().min(1).max(120),
        format: z.enum(FORMATS),
        content: z.string().min(1),
        summary: z.string().min(1).max(4000),
      }),
      _meta: ui,
    },
    guard(async (args: { workspace_id?: string; title: string; format: (typeof FORMATS)[number]; content: string; summary: string }) => {
      const ws = await resolveWorkspace(ctx, args.workspace_id);
      if (args.format === "json") {
        try {
          JSON.parse(args.content);
        } catch {
          throw new UserError("That isn't valid JSON.");
        }
      }
      const { data, error } = await ctx.supabase.rpc("publish_artifact", {
        ws: ws.id,
        p_title: args.title.trim(),
        p_format: args.format,
        p_content: args.content,
        p_summary: args.summary.trim(),
      });
      if (error) throw new UserError(error.message);
      const v = await artifactView(ctx, data as string);
      return result(`Published "${v.artifact.title}" as v1 in ${ws.name}. Your teammates can see it now.`, v);
    }),
  );

  registerAppTool(
    server,
    "propose_change",
    {
      title: "Propose a change",
      description:
        "Propose a new version of an existing artifact. Pass the complete new content (not a diff), based on the current official version from get_artifact. Every other member must approve it.",
      inputSchema: z.object({
        artifact_id: z.string().uuid(),
        content: z.string().min(1),
        summary: z.string().min(1).max(4000),
      }),
      _meta: ui,
    },
    guard(async ({ artifact_id, content, summary }: { artifact_id: string; content: string; summary: string }) => {
      const { supabase, user } = ctx;
      const { data: artifact } = await supabase.from("artifacts").select("*").eq("id", artifact_id).maybeSingle<Artifact>();
      if (!artifact?.current_version_id) throw new UserError("Artifact not found.");
      const { data: base } = await supabase
        .from("artifact_versions")
        .select("*")
        .eq("id", artifact.current_version_id)
        .single<ArtifactVersion>();
      if (!base) throw new UserError("Couldn't load the official version.");
      if (content === base.content) throw new UserError("Nothing changed from the official version.");
      const diff = makeDiff(artifact.title, base.content, content);

      // Like a private thread, keep one live proposal per author per artifact: resending revises it.
      const { data: existing } = await supabase
        .from("proposals")
        .select("*")
        .eq("artifact_id", artifact.id)
        .eq("author_id", user.id)
        .in("status", ["open", "rejected", "needs_rebase"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<Proposal>();

      const { data: pid, error } = existing
        ? await supabase.rpc("revise_proposal", {
            pid: existing.id,
            new_base: base.id,
            p_content: content,
            p_summary: summary.trim(),
            p_diff: diff,
          })
        : await supabase.rpc("create_proposal", {
            art: artifact.id,
            base: base.id,
            p_content: content,
            p_summary: summary.trim(),
            p_diff: diff,
            p_thread: null,
          });
      if (error) throw new UserError(error.message);
      const v = await proposalView(ctx, pid as string);
      const lead = existing ? "Revised your proposal" : "Sent a proposal";
      return result(
        `${lead} on "${artifact.title}" against official v${base.version_number}. Status: ${v.proposal.status}.`,
        v,
      );
    }),
  );

  registerAppTool(
    server,
    "create_workspace",
    {
      title: "Create workspace",
      description: "Create a new workspace (2–5 people). The user becomes its creator and can invite others.",
      inputSchema: z.object({ name: z.string().min(1).max(80) }),
      _meta: ui,
    },
    guard(async ({ name }: { name: string }) => {
      const { data, error } = await ctx.supabase
        .from("workspaces")
        .insert({ name: name.trim(), created_by: ctx.user.id })
        .select("id")
        .single();
      if (error) throw new UserError(error.message);
      const v = await membersView(ctx, data.id);
      return result(`Created "${v.workspace.name}". Share the invite link to add teammates.\n\n${membersText(v)}`, v);
    }),
  );

  registerAppTool(
    server,
    "join_workspace",
    {
      title: "Join workspace",
      description:
        "Join a workspace from an invite link (or its token), or accept a pending email invitation by invitation_id.",
      inputSchema: z.object({
        invite_link: z.string().max(500).optional(),
        invitation_id: z.string().uuid().optional(),
      }),
      _meta: ui,
    },
    guard(async ({ invite_link, invitation_id }: { invite_link?: string; invitation_id?: string }) => {
      let wsId: string;
      if (invitation_id) {
        const { data, error } = await ctx.supabase.rpc("accept_invite", { invite_id: invitation_id });
        if (error) throw new UserError(error.message);
        wsId = data as string;
      } else {
        const token = invite_link?.match(TOKEN_RE)?.[0];
        if (!token) throw new UserError("Pass the invite link (…/join/<token>) or an invitation_id.");
        const { data, error } = await ctx.supabase.rpc("join_workspace", { p_token: token });
        if (error) {
          throw new UserError(/at most 5/.test(error.message) ? "That workspace is full (5 members)." : error.message);
        }
        wsId = data as string;
      }
      const v = await workspaceView(ctx, wsId);
      return result(`You're in "${v.workspace.name}".\n\n${workspaceText(v)}`, v);
    }),
  );

  registerAppTool(
    server,
    "show_members",
    {
      title: "Members and invites",
      description:
        "Show a workspace's members, pending invites and (for its creator) the shareable invite link, with controls to invite or remove people.",
      inputSchema: z.object({ workspace_id: z.string().uuid().optional() }),
      annotations: { readOnlyHint: true },
      _meta: ui,
    },
    guard(async ({ workspace_id }: { workspace_id?: string }) => {
      const v = await membersView(ctx, workspace_id);
      return result(membersText(v), v);
    }),
  );

  registerAppTool(
    server,
    "invite_member",
    {
      title: "Invite by email",
      description:
        "Invite someone to a workspace by email (creator only). They see the invite after signing in with that email. The app doesn't send email; share the invite link too.",
      inputSchema: z.object({ workspace_id: z.string().uuid(), email: z.string().email() }),
      _meta: ui,
    },
    guard(async ({ workspace_id, email }: { workspace_id: string; email: string }) => {
      const before = await membersView(ctx, workspace_id);
      if (!before.isCreator) throw new UserError("Only the workspace creator can invite people.");
      if (before.seatsLeft <= 0) throw new UserError("A workspace can have at most 5 members, including pending invites.");
      const { error } = await ctx.supabase
        .from("workspace_invites")
        .insert({ workspace_id, email: email.trim().toLowerCase(), invited_by: ctx.user.id });
      if (error) throw new UserError(error.code === "23505" ? "That person is already invited." : error.message);
      const v = await membersView(ctx, workspace_id);
      return result(`Invited ${email}.\n\n${membersText(v)}`, v);
    }),
  );

  registerAppTool(
    server,
    "revoke_invite",
    {
      title: "Revoke invite",
      description: "Cancel a pending email invite (creator only).",
      inputSchema: z.object({ workspace_id: z.string().uuid(), invite_id: z.string().uuid() }),
      _meta: ui,
    },
    guard(async ({ workspace_id, invite_id }: { workspace_id: string; invite_id: string }) => {
      const { error } = await ctx.supabase.from("workspace_invites").delete().eq("id", invite_id);
      if (error) throw new UserError(error.message);
      const v = await membersView(ctx, workspace_id);
      return result(`Invite revoked.\n\n${membersText(v)}`, v);
    }),
  );

  registerAppTool(
    server,
    "reset_invite_link",
    {
      title: "Reset invite link",
      description: "Replace the workspace's invite link; the old one stops working (creator only).",
      inputSchema: z.object({ workspace_id: z.string().uuid() }),
      _meta: ui,
    },
    guard(async ({ workspace_id }: { workspace_id: string }) => {
      const { error } = await ctx.supabase.rpc("workspace_invite_token", { ws: workspace_id, rotate: true });
      if (error) throw new UserError(error.message);
      const v = await membersView(ctx, workspace_id);
      return result(`New invite link: ${v.inviteLink}. The old one no longer works.`, v);
    }),
  );

  registerAppTool(
    server,
    "remove_member",
    {
      title: "Remove member",
      description:
        "Remove someone from a workspace (creator only). Closes their open proposals, deletes their private threads there, and resets the invite link. Only call this when the user explicitly asks.",
      inputSchema: z.object({ workspace_id: z.string().uuid(), user_id: z.string().uuid() }),
      annotations: { destructiveHint: true },
      _meta: ui,
    },
    guard(async ({ workspace_id, user_id }: { workspace_id: string; user_id: string }) => {
      const before = await membersView(ctx, workspace_id);
      const who = before.members.find((m) => m.id === user_id)?.name ?? "That person";
      const { error } = await ctx.supabase.rpc("remove_member", { ws: workspace_id, target: user_id });
      if (error) throw new UserError(error.message);
      const v = await membersView(ctx, workspace_id);
      return result(`${who} was removed. Their open proposals were closed and the invite link was reset.\n\n${membersText(v)}`, v);
    }),
  );

  return server;
}
