import { CSRF_TOKEN_COOKIE_NAME, getStoredAccessToken, getStoredRefreshToken, storeAuthSession, type DeveloperProfile } from './auth-storage';

const AUTH_REQUEST_TIMEOUT_MS = 35_000;

// All auth and org requests go through the Express server at the same origin.
// Express handles auth locally (/api/auth/*) and proxies org calls through /api/organization/*.
const LOCAL_API_BASE = '/api';

// Kept for external references (e.g. error messages). Not used for API calls.
export const ONEINFER_API_BASE_URL = (
  import.meta.env.VITE_ONEINFER_API_BASE_URL || 'http://localhost:8001/api/v1'
).replace(/\/$/, '');

export interface AuthConfig {
  google_client_id?: string | null;
}

export interface AuthResponse extends DeveloperProfile {
  access_token?: string | null;
  refresh_token?: string | null;
  email: string;
}

export type OrganizationType = 'individual' | 'business';
export type Designation = 'developer' | 'founder_ceo_cto' | 'manager' | 'student' | 'other';
export type OrganizationRole = 'admin' | 'manager' | 'member';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked';

export interface RegistrationCheckResponse {
  is_registered: boolean;
  email?: string | null;
}

export interface DeveloperRegisterPayload {
  email: string;
  verification_token: string;
  first_name: string;
  last_name: string;
  dob: string;
  organization_type: OrganizationType;
  organization_name?: string;
  designation: Designation;
}

export interface EmailOtpVerificationResponse {
  is_verified: boolean;
  message?: string | null;
  verification_token?: string | null;
}

export interface OrganizationResponse {
  id: string;
  organization_id: string;
  name: string;
  contact_email: string;
  owner_developer_id: string;
  current_user_role: OrganizationRole;
  current_user_email: string;
  created_at: string;
  updated_at: string;
}

export interface OrganizationCreatePayload {
  name: string;
  contact_email: string;
}

export interface OrganizationUpdatePayload {
  name?: string;
  contact_email?: string;
}

export interface OrganizationMemberResponse {
  developer_id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  role: OrganizationRole;
  joined_at: string;
  created_at: string;
  updated_at: string;
}

export interface OrganizationInvitationResponse {
  id: string;
  organization_id: string;
  organization_name?: string;
  email: string;
  role: OrganizationRole;
  status: InvitationStatus;
  invited_by_developer_id: string;
  accepted_by_developer_id?: string | null;
  created_at: string;
  updated_at: string;
  accepted_at?: string | null;
  revoked_at?: string | null;
}

export interface OrganizationInvitationCreatePayload {
  email: string;
  role: OrganizationRole;
}

export interface TeamResponse {
  id: string;
  organization_id: string;
  name: string;
  description?: string | null;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface TeamCreatePayload {
  name: string;
  description?: string | null;
}

export interface TeamUpdatePayload {
  name?: string;
  description?: string | null;
}

export interface TeamMemberResponse {
  team_id: string;
  developer_id: string;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  role: OrganizationRole;
  created_at: string;
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Singleton promise so concurrent 401s don't fire multiple /refresh calls.
let activeRefreshPromise: Promise<string | null> | null = null;

async function tryRefreshToken(): Promise<string | null> {
  if (activeRefreshPromise) return activeRefreshPromise;
  activeRefreshPromise = (async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const refreshToken = getStoredRefreshToken();
      const res = await fetch(`${LOCAL_API_BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        ...(refreshToken ? { body: JSON.stringify({ refresh_token: refreshToken }) } : {}),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json() as AuthResponse;
      if (data.access_token && data.developer_id) {
        storeAuthSession(data.access_token, data.refresh_token ?? null, {
          developer_id: data.developer_id,
          email: data.email ?? null,
          first_name: data.first_name ?? null,
          last_name: data.last_name ?? null,
        });
      }
      return data.access_token ?? null;
    } catch {
      return null;
    } finally {
      window.clearTimeout(timeoutId);
    }
  })().finally(() => { activeRefreshPromise = null; });
  return activeRefreshPromise;
}

async function authRequest<T>(path: string, init?: RequestInit, isRetry = false): Promise<T> {
  const { headers: extraHeaders, signal: _signal, ...rest } = init ?? {};
  const method = (rest.method || 'GET').toUpperCase();
  const headers = new Headers(extraHeaders);
  const isFormDataBody = typeof FormData !== 'undefined' && rest.body instanceof FormData;
  const hasBody = rest.body !== undefined && rest.body !== null;
  const csrfToken = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
    ? null
    : readCookie(CSRF_TOKEN_COOKIE_NAME);
  const storedAccessToken = getStoredAccessToken();
  if (storedAccessToken && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${storedAccessToken}`);
  }
  if (hasBody && !isFormDataBody && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (csrfToken && !headers.has('X-CSRF-Token')) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);
  let res: Response;

  try {
    res = await fetch(`${LOCAL_API_BASE}${path}`, {
      credentials: 'include',
      headers,
      ...rest,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Authentication request timed out. Please try again.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!res.ok) {
    // On 401, attempt a silent token refresh and retry the original request once.
    if (res.status === 401 && !isRetry) {
      const newToken = await tryRefreshToken();
      if (newToken) return authRequest<T>(path, init, true);
    }
    const body = await res.json().catch(() => ({}));
    const detail = isRecord(body) ? body.detail : undefined;
    const message = typeof detail === 'string'
      ? detail
      : isRecord(detail) && typeof detail.message === 'string'
        ? detail.message
        : `HTTP ${res.status}`;
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}

function authHeader(accessToken: string | null | undefined): Record<string, string> {
  const token = accessToken && accessToken !== 'cookie' ? accessToken : getStoredAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getEmailFromGoogleCredential(credential: string): string | null {
  const decodedCredential = decodeJwtPayload(credential);
  return typeof decodedCredential.email === 'string' ? decodedCredential.email : null;
}

export function fetchAuthConfig() {
  return authRequest<AuthConfig>('/auth/config');
}

export function fetchCurrentDeveloper(_accessToken?: string | null) {
  return authRequest<DeveloperProfile>('/auth/me');
}

export function sendOtp(email: string, purpose: 'login' | 'signup' = 'login') {
  return authRequest<{ response: unknown }>('/auth/generate-and-send-otp', {
    method: 'POST',
    body: JSON.stringify({ email, purpose }),
  });
}

export function verifyEmailOtp(email: string, otp: string, purpose: 'login' | 'signup' = 'login') {
  return authRequest<EmailOtpVerificationResponse>('/auth/verify-email-otp', {
    method: 'POST',
    body: JSON.stringify({ email, otp, purpose }),
  });
}

export function verifyDeveloperRegistration(email: string) {
  return authRequest<RegistrationCheckResponse>('/auth/developer/verify-registration', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function recordDeveloperConsent(email: string) {
  return authRequest<{ response: unknown }>('/auth/developer/consent', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function registerDeveloper(payload: DeveloperRegisterPayload) {
  return authRequest<AuthResponse>('/auth/developer/register', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function loginWithOtp(email: string, otp: string) {
  return authRequest<AuthResponse>('/auth/developer/login', {
    method: 'POST',
    body: JSON.stringify({ email, otp }),
  });
}

export function loginWithGoogle(clientId: string, credential: string, selectBy?: string) {
  return authRequest<AuthResponse>('/auth/developer/google-login', {
    method: 'POST',
    body: JSON.stringify({ client_id: clientId, credential, select_by: selectBy ?? '' }),
  });
}

export function refreshAuth(refreshToken?: string | null) {
  const token = refreshToken ?? getStoredRefreshToken();
  return authRequest<AuthResponse>('/auth/refresh', {
    method: 'POST',
    ...(token ? { body: JSON.stringify({ refresh_token: token }) } : {}),
  });
}

export function logoutAuth() {
  return authRequest<void>('/auth/logout', { method: 'POST' });
}

export function exchangeSSOToken(token: string) {
  return authRequest<AuthResponse>('/auth/sso-token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export function fetchOrganizations(accessToken: string) {
  return authRequest<OrganizationResponse[]>('/organization/', { headers: authHeader(accessToken) });
}

export function createOrganization(accessToken: string, payload: OrganizationCreatePayload) {
  return authRequest<OrganizationResponse>('/organization/', {
    method: 'POST',
    headers: authHeader(accessToken),
    body: JSON.stringify(payload),
  });
}

export function updateOrganization(accessToken: string, organizationId: string, payload: OrganizationUpdatePayload) {
  return authRequest<OrganizationResponse>(`/organization/${organizationId}`, {
    method: 'PATCH',
    headers: authHeader(accessToken),
    body: JSON.stringify(payload),
  });
}

export function fetchPendingOrganizationInvitations(accessToken: string) {
  return authRequest<OrganizationInvitationResponse[]>('/organization/invitations/pending', {
    headers: authHeader(accessToken),
  });
}

export function acceptOrganizationInvitation(accessToken: string, invitationId: string) {
  return authRequest<OrganizationMemberResponse>(`/organization/invitations/${invitationId}/accept`, {
    method: 'POST',
    headers: authHeader(accessToken),
  });
}

export function createOrganizationInvitation(
  accessToken: string,
  organizationId: string,
  payload: OrganizationInvitationCreatePayload,
) {
  return authRequest<OrganizationInvitationResponse>(`/organization/${organizationId}/invitations`, {
    method: 'POST',
    headers: authHeader(accessToken),
    body: JSON.stringify(payload),
  });
}

export function fetchOrganizationInvitations(accessToken: string, organizationId: string) {
  return authRequest<OrganizationInvitationResponse[]>(`/organization/${organizationId}/invitations`, {
    headers: authHeader(accessToken),
  });
}

export function revokeOrganizationInvitation(accessToken: string, organizationId: string, invitationId: string) {
  return authRequest<OrganizationInvitationResponse>(`/organization/${organizationId}/invitations/${invitationId}`, {
    method: 'DELETE',
    headers: authHeader(accessToken),
  });
}

export function fetchOrganizationMembers(accessToken: string, organizationId: string) {
  return authRequest<OrganizationMemberResponse[]>(`/organization/${organizationId}/members`, {
    headers: authHeader(accessToken),
  });
}

export function updateOrganizationMember(
  accessToken: string,
  organizationId: string,
  developerId: string,
  role: OrganizationRole,
) {
  return authRequest<OrganizationMemberResponse>(`/organization/${organizationId}/members/${developerId}`, {
    method: 'PATCH',
    headers: authHeader(accessToken),
    body: JSON.stringify({ role }),
  });
}

export function deleteOrganizationMember(accessToken: string, organizationId: string, developerId: string) {
  return authRequest<void>(`/organization/${organizationId}/members/${developerId}`, {
    method: 'DELETE',
    headers: authHeader(accessToken),
  });
}

export function fetchTeams(accessToken: string, organizationId: string) {
  return authRequest<TeamResponse[]>(`/organization/${organizationId}/teams`, {
    headers: authHeader(accessToken),
  });
}

export function createTeam(accessToken: string, organizationId: string, payload: TeamCreatePayload) {
  return authRequest<TeamResponse>(`/organization/${organizationId}/teams`, {
    method: 'POST',
    headers: authHeader(accessToken),
    body: JSON.stringify(payload),
  });
}

export function updateTeam(accessToken: string, organizationId: string, teamId: string, payload: TeamUpdatePayload) {
  return authRequest<TeamResponse>(`/organization/${organizationId}/teams/${teamId}`, {
    method: 'PATCH',
    headers: authHeader(accessToken),
    body: JSON.stringify(payload),
  });
}

export function deleteTeam(accessToken: string, organizationId: string, teamId: string) {
  return authRequest<void>(`/organization/${organizationId}/teams/${teamId}`, {
    method: 'DELETE',
    headers: authHeader(accessToken),
  });
}

export function fetchTeamMembers(accessToken: string, organizationId: string, teamId: string) {
  return authRequest<TeamMemberResponse[]>(`/organization/${organizationId}/teams/${teamId}/members`, {
    headers: authHeader(accessToken),
  });
}

/** All team memberships across every visible team, in one request — avoids one fetch per team. */
export function fetchAllTeamMembers(accessToken: string, organizationId: string) {
  return authRequest<TeamMemberResponse[]>(`/organization/${organizationId}/teams/members`, {
    headers: authHeader(accessToken),
  });
}

export function groupTeamMembersByTeam(members: TeamMemberResponse[]): Record<string, TeamMemberResponse[]> {
  const byTeam: Record<string, TeamMemberResponse[]> = {};
  for (const member of members) {
    (byTeam[member.team_id] ??= []).push(member);
  }
  return byTeam;
}

export function addTeamMember(accessToken: string, organizationId: string, teamId: string, developerId: string) {
  return authRequest<TeamMemberResponse>(`/organization/${organizationId}/teams/${teamId}/members`, {
    method: 'POST',
    headers: authHeader(accessToken),
    body: JSON.stringify({ developer_id: developerId }),
  });
}

export function deleteTeamMember(accessToken: string, organizationId: string, teamId: string, developerId: string) {
  return authRequest<void>(`/organization/${organizationId}/teams/${teamId}/members/${developerId}`, {
    method: 'DELETE',
    headers: authHeader(accessToken),
  });
}
