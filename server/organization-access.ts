import type { Request } from 'express';
import type { Task } from '../shared/types.js';
import type { JwtPayload } from './auth.js';
import { claimLegacyPersonalTasks } from './db/queries.js';

const DEFAULT_ONEINFER_API_BASE_URL = 'http://localhost:8001/api/v1';
const LOCAL_PERSONAL_DEVELOPER_ID = 'local-vantage-user';

export interface OrganizationMember {
  developer_id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  role?: string;
}

export interface Team {
  id: string;
  organization_id: string;
  name: string;
  description?: string | null;
}

export interface TeamMember {
  team_id: string;
  developer_id: string;
  email: string;
  role?: string;
}

export interface OrganizationAccessContext {
  accessToken: string | null;
  developerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  organizationId: string | null;
  members: OrganizationMember[];
  teams: Team[];
  teamMembers: Map<string, TeamMember[]>;
  currentDeveloperTeamIds: Set<string>;
  currentOrganizationRole: string | null;
}

export interface AssignmentInput {
  organizationId: string;
  teamId?: string | null;
  assigneeDeveloperId?: string | null;
}

export interface ResolvedTaskAssignment {
  organization_id: string | null;
  creator_developer_id: string;
  creator_email: string | null;
  creator_first_name: string | null;
  creator_last_name: string | null;
  team_id: string | null;
  team_name: string | null;
  assignee_developer_id: string | null;
  assignee_email: string | null;
  assignee_first_name: string | null;
  assignee_last_name: string | null;
}

export interface VisibilityParams {
  developerId: string;
  organizationId: string | null;
  isManager: boolean;
  teamIds: Set<string>;
}

export function visibilityParamsFromContext(context: OrganizationAccessContext): VisibilityParams {
  return {
    developerId: context.developerId,
    organizationId: context.organizationId,
    isManager: currentUserIsOrgManager(context),
    teamIds: context.currentDeveloperTeamIds,
  };
}

const ORG_CONTEXT_TTL_MS = 60_000;
interface CachedOrgContext { context: OrganizationAccessContext; expiresAt: number; }
const orgContextCache = new Map<string, CachedOrgContext>();

function orgContextCacheKey(developerId: string, organizationId: string, accessToken: string): string {
  return `${developerId}|${organizationId}|${accessToken}`;
}

export function invalidateOrgContextCache(developerId?: string): void {
  if (!developerId) { orgContextCache.clear(); return; }
  for (const key of orgContextCache.keys()) {
    if (key.startsWith(`${developerId}|`)) orgContextCache.delete(key);
  }
}

type RequestWithAuth = Request & { developer?: JwtPayload; accessToken?: string };

function oneInferBaseUrl(): string {
  return (
    process.env.ONEINFER_API_BASE_URL ||
    process.env.VITE_ONEINFER_API_BASE_URL ||
    DEFAULT_ONEINFER_API_BASE_URL
  ).replace(/\/$/, '');
}

function selectedOrganizationId(req: Request): string | null {
  const header = req.header('x-bees-organization-id')?.trim();
  if (header) return header;
  const query = typeof req.query.organizationId === 'string' ? req.query.organizationId.trim() : '';
  if (query) return query;
  const bodyValue = (req.body as { organizationId?: unknown } | undefined)?.organizationId;
  return typeof bodyValue === 'string' && bodyValue.trim() ? bodyValue.trim() : null;
}

const ONEINFER_FETCH_TIMEOUT_MS = 15_000;

async function oneInferRequest<T>(accessToken: string, path: string): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ONEINFER_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${oneInferBaseUrl()}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : undefined;
    const message = typeof detail === 'string'
      ? detail
      : detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string'
        ? detail.message
        : `OneInfer returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function loadOrganizationAccess(req: Request, organizationIdOverride?: string | null): Promise<OrganizationAccessContext> {
  const authed = req as RequestWithAuth;
  const organizationId = organizationIdOverride ?? selectedOrganizationId(req);
  const email = typeof authed.developer?.email === 'string' ? authed.developer.email : null;
  const firstName = typeof authed.developer?.first_name === 'string' ? authed.developer.first_name : null;
  const lastName = typeof authed.developer?.last_name === 'string' ? authed.developer.last_name : null;
  const accessToken = authed.accessToken ?? null;

  if (!organizationId) {
    claimLegacyPersonalTasks(LOCAL_PERSONAL_DEVELOPER_ID, null);
    return {
      accessToken: null,
      developerId: LOCAL_PERSONAL_DEVELOPER_ID,
      email: null,
      firstName: null,
      lastName: null,
      organizationId: null,
      members: [],
      teams: [],
      teamMembers: new Map(),
      currentDeveloperTeamIds: new Set(),
      currentOrganizationRole: null,
    };
  }

  const developerId = authed.developer?.sub;
  if (!developerId || !accessToken) throw new Error('Organization access token is missing');

  // Claim any legacy tasks (created before auth was configured) for this authenticated user
  claimLegacyPersonalTasks(developerId, email);

  // Check org context cache
  const cacheKey = orgContextCacheKey(developerId, organizationId, accessToken);
  const cached = orgContextCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.context;

  const [members, teams] = await Promise.all([
    oneInferRequest<OrganizationMember[]>(accessToken, `/organization/${encodeURIComponent(organizationId)}/members`),
    oneInferRequest<Team[]>(accessToken, `/organization/${encodeURIComponent(organizationId)}/teams`),
  ]);
  if (!members.some((member) => member.developer_id === developerId)) {
    throw new Error('You are not a member of this organization');
  }
  const currentMember = members.find((member) => member.developer_id === developerId) ?? null;

  const teamEntries = await Promise.all(
    teams.map(async (team) => [
      team.id,
      await oneInferRequest<TeamMember[]>(
        accessToken,
        `/organization/${encodeURIComponent(organizationId)}/teams/${encodeURIComponent(team.id)}/members`,
      ),
    ] as const),
  );
  const teamMembers = new Map(teamEntries);
  const currentDeveloperTeamIds = new Set<string>();
  for (const [teamId, membersForTeam] of teamMembers) {
    if (membersForTeam.some((member) => member.developer_id === developerId)) {
      currentDeveloperTeamIds.add(teamId);
    }
  }

  const context: OrganizationAccessContext = {
    accessToken,
    developerId,
    email,
    firstName,
    lastName,
    organizationId,
    members,
    teams,
    teamMembers,
    currentDeveloperTeamIds,
    currentOrganizationRole: currentMember?.role ?? null,
  };
  orgContextCache.set(cacheKey, { context, expiresAt: Date.now() + ORG_CONTEXT_TTL_MS });
  return context;
}

function currentUserIsOrgManager(context: OrganizationAccessContext): boolean {
  return context.currentOrganizationRole === 'admin' || context.currentOrganizationRole === 'manager';
}

export function taskVisibleToOrganizationContext(task: Task, context: OrganizationAccessContext): boolean {
  if (!task.organization_id) {
    return Boolean(task.creator_developer_id && task.creator_developer_id === context.developerId);
  }
  if (context.organizationId !== task.organization_id) return false;
  if (currentUserIsOrgManager(context)) return true;
  if (task.creator_developer_id === context.developerId) return true;
  if (task.assignee_developer_id === context.developerId) return true;
  if (task.team_id) return context.currentDeveloperTeamIds.has(task.team_id);
  return !task.assignee_developer_id;
}

export function taskMutableByOrganizationContext(task: Task, context: OrganizationAccessContext): boolean {
  if (!taskVisibleToOrganizationContext(task, context)) return false;
  if (!task.organization_id) return task.creator_developer_id === context.developerId;
  if (currentUserIsOrgManager(context)) return true;
  return task.creator_developer_id === context.developerId || task.assignee_developer_id === context.developerId;
}

export function taskManageableByOrganizationContext(task: Task, context: OrganizationAccessContext): boolean {
  if (!taskVisibleToOrganizationContext(task, context)) return false;
  if (!task.organization_id) return task.creator_developer_id === context.developerId;
  return currentUserIsOrgManager(context) || task.creator_developer_id === context.developerId;
}

export function taskStartableByOrganizationContext(task: Task, context: OrganizationAccessContext): boolean {
  if (!taskVisibleToOrganizationContext(task, context)) return false;
  if (!task.organization_id) return task.creator_developer_id === context.developerId;
  if (currentUserIsOrgManager(context)) return true;
  if (task.creator_developer_id === context.developerId) return true;
  if (task.assignee_developer_id === context.developerId) return true;
  return Boolean(task.team_id && !task.assignee_developer_id && context.currentDeveloperTeamIds.has(task.team_id));
}

export function requireTaskVisible(task: Task | undefined, context: OrganizationAccessContext): Task | undefined {
  if (!task) return undefined;
  return taskVisibleToOrganizationContext(task, context) ? task : undefined;
}

export function requireTaskMutable(task: Task | undefined, context: OrganizationAccessContext): Task | undefined {
  if (!task) return undefined;
  return taskMutableByOrganizationContext(task, context) ? task : undefined;
}

export function requireTaskManageable(task: Task | undefined, context: OrganizationAccessContext): Task | undefined {
  if (!task) return undefined;
  return taskManageableByOrganizationContext(task, context) ? task : undefined;
}

export function requireTaskStartable(task: Task | undefined, context: OrganizationAccessContext): Task | undefined {
  if (!task) return undefined;
  return taskStartableByOrganizationContext(task, context) ? task : undefined;
}

export function filterVisibleTasks(tasks: Task[], context: OrganizationAccessContext): Task[] {
  return tasks.filter((task) => taskVisibleToOrganizationContext(task, context));
}

function trimNullable(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Assignment fields must be strings or null');
  const trimmed = value.trim();
  return trimmed || null;
}

export function parseAssignmentInput(req: Request, requireOrganization = true): AssignmentInput {
  const organizationId = trimNullable((req.body as { organizationId?: unknown }).organizationId)
    ?? selectedOrganizationId(req);
  if (requireOrganization && !organizationId) throw new Error('organizationId is required');
  return {
    organizationId: organizationId ?? '',
    teamId: trimNullable((req.body as { teamId?: unknown; team_id?: unknown }).teamId ?? (req.body as { team_id?: unknown }).team_id),
    assigneeDeveloperId: trimNullable(
      (req.body as { assigneeDeveloperId?: unknown; assignee_developer_id?: unknown }).assigneeDeveloperId
      ?? (req.body as { assignee_developer_id?: unknown }).assignee_developer_id,
    ),
  };
}

export function resolveTaskAssignment(
  context: OrganizationAccessContext,
  input: AssignmentInput,
): ResolvedTaskAssignment {
  if (!input.organizationId) {
    if (input.teamId) throw new Error('Personal tasks cannot be scoped to an organization team');
    if (input.assigneeDeveloperId) throw new Error('Personal tasks cannot be assigned to organization members');
    return {
      organization_id: null,
      creator_developer_id: context.developerId,
      creator_email: context.email,
      creator_first_name: null,
      creator_last_name: null,
      team_id: null,
      team_name: null,
      assignee_developer_id: null,
      assignee_email: null,
      assignee_first_name: null,
      assignee_last_name: null,
    };
  }

  if (!context.organizationId || context.organizationId !== input.organizationId) {
    throw new Error('Selected organization is not available');
  }

  const team = input.teamId ? context.teams.find((candidate) => candidate.id === input.teamId) : null;
  if (input.teamId && !team) throw new Error('Selected team was not found in this organization');
  if (team && !context.currentDeveloperTeamIds.has(team.id)) {
    throw new Error('You must be a member of the selected team to create team-scoped tasks');
  }

  const assignee = input.assigneeDeveloperId
    ? context.members.find((member) => member.developer_id === input.assigneeDeveloperId)
    : null;
  if (input.assigneeDeveloperId && !assignee) throw new Error('Selected assignee was not found in this organization');
  if (team && assignee) {
    const membersForTeam = context.teamMembers.get(team.id) ?? [];
    if (!membersForTeam.some((member) => member.developer_id === assignee.developer_id)) {
      throw new Error('Selected assignee is not a member of the selected team');
    }
  }

  return {
    organization_id: context.organizationId,
    creator_developer_id: context.developerId,
    creator_email: context.email,
    creator_first_name: context.firstName,
    creator_last_name: context.lastName,
    team_id: team?.id ?? null,
    team_name: team?.name ?? null,
    assignee_developer_id: assignee?.developer_id ?? null,
    assignee_email: assignee?.email ?? null,
    assignee_first_name: assignee?.first_name ?? null,
    assignee_last_name: assignee?.last_name ?? null,
  };
}
