import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Building2,
  Check,
  LoaderCircle,
  RefreshCcw,
  Shield,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useOrganizations } from '../auth/OrganizationContext';
import {
  addTeamMember,
  createOrganizationInvitation,
  createTeam,
  deleteOrganizationMember,
  deleteTeam,
  deleteTeamMember,
  fetchAllTeamMembers,
  fetchOrganizationInvitations,
  fetchOrganizationMembers,
  fetchTeams,
  groupTeamMembersByTeam,
  revokeOrganizationInvitation,
  updateOrganization,
  updateOrganizationMember,
  updateTeam,
  type OrganizationInvitationResponse,
  type OrganizationMemberResponse,
  type OrganizationResponse,
  type OrganizationRole,
  type TeamMemberResponse,
  type TeamResponse,
} from '../lib/auth-api';
import { toErrorMessage } from '../lib/format';

type TabKey = 'members' | 'invitations' | 'teams' | 'settings';

type OrganizationData = {
  members: OrganizationMemberResponse[];
  invitations: OrganizationInvitationResponse[];
  teams: TeamResponse[];
  teamMembers: Record<string, TeamMemberResponse[]>;
};

type InviteDraft = {
  email: string;
  role: OrganizationRole;
};

type TeamDraft = {
  name: string;
  description: string;
};

type OrganizationSettingsDraft = {
  name: string;
  contactEmail: string;
};

const tabs: { key: TabKey; label: string }[] = [
  { key: 'members', label: 'Members' },
  { key: 'invitations', label: 'Invitations' },
  { key: 'teams', label: 'Teams' },
  { key: 'settings', label: 'Settings' },
];
const roleOptions: { value: OrganizationRole; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'member', label: 'Member' },
];

function emptyData(): OrganizationData {
  return { members: [], invitations: [], teams: [], teamMembers: {} };
}

function roleLabel(role: OrganizationRole): string {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  return 'Member';
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

function canManagePeople(role: OrganizationRole): boolean {
  return role === 'admin' || role === 'manager';
}

function canManageTarget(actorRole: OrganizationRole, targetRole: OrganizationRole): boolean {
  if (actorRole === 'admin') return true;
  return actorRole === 'manager' && targetRole === 'member';
}

function allowedRoles(actorRole: OrganizationRole): OrganizationRole[] {
  return actorRole === 'admin' ? ['admin', 'manager', 'member'] : ['member'];
}

export function OrganizationPage() {
  const { accessToken, developer } = useAuth();
  const { organizations, selectedOrganization, selectOrganization: selectOrganizationInContext, refreshOrganizations } = useOrganizations();
  const [activeTab, setActiveTab] = useState<TabKey>('members');
  const [dataByOrganization, setDataByOrganization] = useState<Record<string, OrganizationData>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [inviteDraft, setInviteDraft] = useState<InviteDraft>({ email: '', role: 'member' });
  const [teamDraft, setTeamDraft] = useState<TeamDraft>({ name: '', description: '' });
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [editingTeamDraft, setEditingTeamDraft] = useState<TeamDraft>({ name: '', description: '' });
  const [settingsDraft, setSettingsDraft] = useState<OrganizationSettingsDraft>({ name: '', contactEmail: '' });

  const organizationId = selectedOrganization?.organization_id ?? '';
  const data = dataByOrganization[organizationId] ?? emptyData();
  const canManage = Boolean(selectedOrganization && canManagePeople(selectedOrganization.current_user_role));
  const canEditSettings = selectedOrganization?.current_user_role === 'admin';

  useEffect(() => {
    if (!selectedOrganization) return;
    setSettingsDraft({
      name: selectedOrganization.name,
      contactEmail: selectedOrganization.contact_email,
    });
  }, [selectedOrganization]);

  const loadOrganizationData = useCallback(async (nextOrganizationId: string) => {
    if (!accessToken || !nextOrganizationId) return;
    setLoading(true);
    setError(null);
    try {
      const [members, invitations, teams, allTeamMembers] = await Promise.all([
        fetchOrganizationMembers(accessToken, nextOrganizationId),
        fetchOrganizationInvitations(accessToken, nextOrganizationId).catch((err) => {
          const message = toErrorMessage(err, '');
          if (message.includes('manager access')) return [];
          throw err;
        }),
        fetchTeams(accessToken, nextOrganizationId),
        fetchAllTeamMembers(accessToken, nextOrganizationId),
      ]);
      setDataByOrganization((current) => ({
        ...current,
        [nextOrganizationId]: {
          members,
          invitations,
          teams,
          teamMembers: groupTeamMembersByTeam(allTeamMembers),
        },
      }));
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to load organization.'));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (!organizationId) return;
    void loadOrganizationData(organizationId);
  }, [loadOrganizationData, organizationId]);

  const handleSelectOrganization = (nextOrganizationId: string) => {
    selectOrganizationInContext(nextOrganizationId);
    setError(null);
    setActionStatus(null);
  };

  const reload = async () => {
    if (!organizationId) return;
    await Promise.all([
      refreshOrganizations().catch(() => undefined),
      loadOrganizationData(organizationId),
    ]);
  };

  const handleInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (!accessToken || !selectedOrganization) return;
    const email = inviteDraft.email.trim();
    if (!email) {
      setActionStatus('Email is required.');
      return;
    }
    const currentUserEmails = [developer?.email, selectedOrganization.current_user_email].map(normalizeEmail);
    if (currentUserEmails.includes(normalizeEmail(email))) {
      setActionStatus('You cannot invite yourself to this organization.');
      return;
    }
    setActionStatus('Inviting...');
    try {
      await createOrganizationInvitation(accessToken, selectedOrganization.organization_id, { email, role: inviteDraft.role });
      setInviteDraft({ email: '', role: 'member' });
      await loadOrganizationData(selectedOrganization.organization_id);
      setActionStatus('Invitation created.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to invite member.'));
    }
  };

  const handleRoleChange = async (member: OrganizationMemberResponse, role: OrganizationRole) => {
    if (!accessToken || !selectedOrganization || role === member.role) return;
    setActionStatus('Updating role...');
    try {
      await updateOrganizationMember(accessToken, selectedOrganization.organization_id, member.developer_id, role);
      await loadOrganizationData(selectedOrganization.organization_id);
      setActionStatus('Role updated.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to update role.'));
    }
  };

  const handleRemoveMember = async (member: OrganizationMemberResponse) => {
    if (!accessToken || !selectedOrganization) return;
    setActionStatus('Removing member...');
    try {
      await deleteOrganizationMember(accessToken, selectedOrganization.organization_id, member.developer_id);
      await loadOrganizationData(selectedOrganization.organization_id);
      setActionStatus('Member removed.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to remove member.'));
    }
  };

  const handleRevokeInvitation = async (invitation: OrganizationInvitationResponse) => {
    if (!accessToken || !selectedOrganization) return;
    setActionStatus('Revoking invitation...');
    try {
      await revokeOrganizationInvitation(accessToken, selectedOrganization.organization_id, invitation.id);
      await loadOrganizationData(selectedOrganization.organization_id);
      setActionStatus('Invitation revoked.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to revoke invitation.'));
    }
  };

  const handleCreateTeam = async (event: FormEvent) => {
    event.preventDefault();
    if (!accessToken || !selectedOrganization) return;
    const name = teamDraft.name.trim();
    if (name.length < 2) {
      setActionStatus('Team name must be at least 2 characters.');
      return;
    }
    setActionStatus('Creating team...');
    try {
      await createTeam(accessToken, selectedOrganization.organization_id, {
        name,
        description: teamDraft.description.trim() || null,
      });
      setTeamDraft({ name: '', description: '' });
      await loadOrganizationData(selectedOrganization.organization_id);
      setActionStatus('Team created.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to create team.'));
    }
  };

  const startEditingTeam = (team: TeamResponse) => {
    setEditingTeamId(team.id);
    setEditingTeamDraft({ name: team.name, description: team.description ?? '' });
    setActionStatus(null);
  };

  const handleUpdateTeam = async (team: TeamResponse) => {
    if (!accessToken || !selectedOrganization) return;
    const name = editingTeamDraft.name.trim();
    if (name.length < 2) {
      setActionStatus('Team name must be at least 2 characters.');
      return;
    }
    setActionStatus('Saving team...');
    try {
      await updateTeam(accessToken, selectedOrganization.organization_id, team.id, {
        name,
        description: editingTeamDraft.description.trim() || null,
      });
      setEditingTeamId(null);
      await loadOrganizationData(selectedOrganization.organization_id);
      setActionStatus('Team saved.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to save team.'));
    }
  };

  const handleDeleteTeam = async (team: TeamResponse) => {
    if (!accessToken || !selectedOrganization) return;
    setActionStatus('Deleting team...');
    try {
      await deleteTeam(accessToken, selectedOrganization.organization_id, team.id);
      await loadOrganizationData(selectedOrganization.organization_id);
      setActionStatus('Team deleted.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to delete team.'));
    }
  };

  const handleAddTeamMember = async (team: TeamResponse, developerId: string) => {
    if (!accessToken || !selectedOrganization || !developerId) return;
    setActionStatus('Adding team member...');
    try {
      await addTeamMember(accessToken, selectedOrganization.organization_id, team.id, developerId);
      await loadOrganizationData(selectedOrganization.organization_id);
      setActionStatus('Team member added.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to add team member.'));
    }
  };

  const handleRemoveTeamMember = async (team: TeamResponse, member: TeamMemberResponse) => {
    if (!accessToken || !selectedOrganization) return;
    setActionStatus('Removing team member...');
    try {
      await deleteTeamMember(accessToken, selectedOrganization.organization_id, team.id, member.developer_id);
      await loadOrganizationData(selectedOrganization.organization_id);
      setActionStatus('Team member removed.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to remove team member.'));
    }
  };

  const handleSaveSettings = async (event: FormEvent) => {
    event.preventDefault();
    if (!accessToken || !selectedOrganization) return;
    const name = settingsDraft.name.trim();
    const contactEmail = settingsDraft.contactEmail.trim();
    if (name.length < 2) {
      setActionStatus('Organization name must be at least 2 characters.');
      return;
    }
    if (!contactEmail) {
      setActionStatus('Contact email is required.');
      return;
    }
    setActionStatus('Saving organization...');
    try {
      const updated = await updateOrganization(accessToken, selectedOrganization.organization_id, {
        name,
        contact_email: contactEmail,
      });
      await refreshOrganizations();
      setSettingsDraft({ name: updated.name, contactEmail: updated.contact_email });
      setActionStatus('Organization saved.');
    } catch (err) {
      setActionStatus(toErrorMessage(err, 'Failed to save organization.'));
    }
  };

  if (!selectedOrganization) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="rounded-lg border border-zinc-200 bg-white p-5 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          No organization is available for this account.
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Building2 size={18} className="text-zinc-500 dark:text-zinc-400" />
                <h2 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-100">
                  {selectedOrganization.name}
                </h2>
                <RoleBadge role={selectedOrganization.current_user_role} />
              </div>
              {developer?.email && (
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                  {developer.email}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {organizations.length > 1 && (
                <select
                  value={selectedOrganization.organization_id}
                  onChange={(event) => handleSelectOrganization(event.target.value)}
                  aria-label="Select organization"
                  className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 pr-7 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                >
                  {organizations.map((organization) => (
                    <option key={organization.organization_id} value={organization.organization_id}>
                      {organization.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => void reload()}
                disabled={loading}
                className="inline-flex h-9 items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
              >
                {loading ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCcw size={14} />}
                Refresh
              </button>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1 dark:border-zinc-800 dark:bg-zinc-950">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`h-8 rounded-md px-3 text-xs font-medium transition-colors ${
                  activeTab === tab.key
                    ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {(error || actionStatus) && (
            <div
              className={`mt-4 rounded-md border px-3 py-2 text-sm ${
                error || actionStatus?.toLowerCase().includes('failed') || actionStatus?.toLowerCase().includes('cannot') || actionStatus?.toLowerCase().includes('required')
                  ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200'
              }`}
            >
              {error ?? actionStatus}
            </div>
          )}
        </section>

        {activeTab === 'members' && (
          <MembersTab
            organization={selectedOrganization}
            developerId={developer?.developer_id}
            members={data.members}
            canManage={canManage}
            onRoleChange={handleRoleChange}
            onRemoveMember={handleRemoveMember}
          />
        )}
        {activeTab === 'invitations' && (
          <InvitationsTab
            organization={selectedOrganization}
            invitations={data.invitations}
            inviteDraft={inviteDraft}
            canManage={canManage}
            onInviteDraftChange={setInviteDraft}
            onInvite={handleInvite}
            onRevoke={handleRevokeInvitation}
          />
        )}
        {activeTab === 'teams' && (
          <TeamsTab
            organization={selectedOrganization}
            members={data.members}
            teams={data.teams}
            teamMembers={data.teamMembers}
            canManage={canManage}
            teamDraft={teamDraft}
            editingTeamId={editingTeamId}
            editingTeamDraft={editingTeamDraft}
            onTeamDraftChange={setTeamDraft}
            onCreateTeam={handleCreateTeam}
            onStartEditingTeam={startEditingTeam}
            onEditingTeamDraftChange={setEditingTeamDraft}
            onCancelEditingTeam={() => setEditingTeamId(null)}
            onUpdateTeam={handleUpdateTeam}
            onDeleteTeam={handleDeleteTeam}
            onAddTeamMember={handleAddTeamMember}
            onRemoveTeamMember={handleRemoveTeamMember}
          />
        )}
        {activeTab === 'settings' && (
          <SettingsTab
            canEdit={canEditSettings}
            draft={settingsDraft}
            onDraftChange={setSettingsDraft}
            onSave={handleSaveSettings}
          />
        )}
      </div>
    </div>
  );
}

function MembersTab({
  organization,
  developerId,
  members,
  canManage,
  onRoleChange,
  onRemoveMember,
}: {
  organization: OrganizationResponse;
  developerId?: string;
  members: OrganizationMemberResponse[];
  canManage: boolean;
  onRoleChange: (member: OrganizationMemberResponse, role: OrganizationRole) => void;
  onRemoveMember: (member: OrganizationMemberResponse) => void;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <SectionHeader title="Members" description={`${members.length} member${members.length === 1 ? '' : 's'} in this organization.`} />
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {members.map((member) => {
          const isOwner = organization.owner_developer_id === member.developer_id;
          const isCurrentUser = developerId === member.developer_id;
          const canManageThisMember = canManage && !isCurrentUser && canManageTarget(organization.current_user_role, member.role);
          return (
            <div key={member.developer_id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_9rem_10rem_auto] md:items-center sm:px-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{member.email}</p>
                  {isOwner && <SmallBadge>Owner</SmallBadge>}
                  {isCurrentUser && <SmallBadge>You</SmallBadge>}
                </div>
                <p className="mt-1 truncate text-xs text-zinc-400 dark:text-zinc-500">{member.developer_id}</p>
              </div>
              <RoleBadge role={member.role} />
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Joined {formatDate(member.joined_at)}</span>
              <div className="flex items-center justify-start gap-2 md:justify-end">
                {canManageThisMember ? (
                  <>
                    <select
                      value={member.role}
                      onChange={(event) => onRoleChange(member, event.target.value as OrganizationRole)}
                      aria-label={`Role for ${member.email}`}
                      className="h-8 rounded-lg border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                    >
                      {roleOptions.map((role) => (
                        <option key={role.value} value={role.value} disabled={!allowedRoles(organization.current_user_role).includes(role.value)}>
                          {role.label}
                        </option>
                      ))}
                    </select>
                    <IconButton label={`Remove ${member.email}`} onClick={() => onRemoveMember(member)}>
                      <UserMinus size={14} />
                    </IconButton>
                  </>
                ) : (
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">Read only</span>
                )}
              </div>
            </div>
          );
        })}
        {members.length === 0 && <EmptyState label="No members found." />}
      </div>
    </section>
  );
}

function InvitationsTab({
  organization,
  invitations,
  inviteDraft,
  canManage,
  onInviteDraftChange,
  onInvite,
  onRevoke,
}: {
  organization: OrganizationResponse;
  invitations: OrganizationInvitationResponse[];
  inviteDraft: InviteDraft;
  canManage: boolean;
  onInviteDraftChange: (draft: InviteDraft) => void;
  onInvite: (event: FormEvent) => void;
  onRevoke: (invitation: OrganizationInvitationResponse) => void;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <SectionHeader title="Invitations" description="Invite developers and track pending organization invitations." />
      {canManage && (
        <form onSubmit={onInvite} className="grid gap-2 border-b border-zinc-100 px-4 pb-4 dark:border-zinc-800 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:px-5">
          <input
            type="email"
            required
            value={inviteDraft.email}
            onChange={(event) => onInviteDraftChange({ ...inviteDraft, email: event.target.value })}
            placeholder="developer@example.com"
            aria-label="Invite email"
            className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
          />
          <select
            value={inviteDraft.role}
            onChange={(event) => onInviteDraftChange({ ...inviteDraft, role: event.target.value as OrganizationRole })}
            aria-label="Invite role"
            className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
          >
            {roleOptions.map((role) => (
              <option key={role.value} value={role.value} disabled={!allowedRoles(organization.current_user_role).includes(role.value)}>
                {role.label}
              </option>
            ))}
          </select>
          <button type="submit" className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">
            <UserPlus size={14} />
            Invite
          </button>
        </form>
      )}
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {invitations.map((invitation) => (
          <div key={invitation.id} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_8rem_9rem_auto] md:items-center sm:px-5">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{invitation.email}</p>
              <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">Invited {formatDate(invitation.created_at)}</p>
            </div>
            <RoleBadge role={invitation.role} />
            <span className="text-xs font-medium capitalize text-zinc-500 dark:text-zinc-400">{invitation.status}</span>
            <div className="flex justify-start md:justify-end">
              {canManage && invitation.status === 'pending' ? (
                <IconButton label={`Revoke invitation for ${invitation.email}`} onClick={() => onRevoke(invitation)}>
                  <Trash2 size={14} />
                </IconButton>
              ) : (
                <span className="text-xs text-zinc-400 dark:text-zinc-500">No action</span>
              )}
            </div>
          </div>
        ))}
        {invitations.length === 0 && <EmptyState label={canManage ? 'No invitations yet.' : 'No visible invitations.'} />}
      </div>
    </section>
  );
}

function TeamsTab({
  members,
  teams,
  teamMembers,
  canManage,
  teamDraft,
  editingTeamId,
  editingTeamDraft,
  onTeamDraftChange,
  onCreateTeam,
  onStartEditingTeam,
  onEditingTeamDraftChange,
  onCancelEditingTeam,
  onUpdateTeam,
  onDeleteTeam,
  onAddTeamMember,
  onRemoveTeamMember,
}: {
  organization: OrganizationResponse;
  members: OrganizationMemberResponse[];
  teams: TeamResponse[];
  teamMembers: Record<string, TeamMemberResponse[]>;
  canManage: boolean;
  teamDraft: TeamDraft;
  editingTeamId: string | null;
  editingTeamDraft: TeamDraft;
  onTeamDraftChange: (draft: TeamDraft) => void;
  onCreateTeam: (event: FormEvent) => void;
  onStartEditingTeam: (team: TeamResponse) => void;
  onEditingTeamDraftChange: (draft: TeamDraft) => void;
  onCancelEditingTeam: () => void;
  onUpdateTeam: (team: TeamResponse) => void;
  onDeleteTeam: (team: TeamResponse) => void;
  onAddTeamMember: (team: TeamResponse, developerId: string) => void;
  onRemoveTeamMember: (team: TeamResponse, member: TeamMemberResponse) => void;
}) {
  const memberById = useMemo(() => new Map(members.map((member) => [member.developer_id, member])), [members]);

  return (
    <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <SectionHeader title="Teams" description={`${teams.length} team${teams.length === 1 ? '' : 's'} in this organization.`} />
      {canManage && (
        <form onSubmit={onCreateTeam} className="grid gap-2 border-b border-zinc-100 px-4 pb-4 dark:border-zinc-800 md:grid-cols-[14rem_minmax(0,1fr)_auto] sm:px-5">
          <input
            value={teamDraft.name}
            onChange={(event) => onTeamDraftChange({ ...teamDraft, name: event.target.value })}
            placeholder="Team name"
            aria-label="Team name"
            className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
          />
          <input
            value={teamDraft.description}
            onChange={(event) => onTeamDraftChange({ ...teamDraft, description: event.target.value })}
            placeholder="Description"
            aria-label="Team description"
            className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
          />
          <button type="submit" className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">
            <Users size={14} />
            Create
          </button>
        </form>
      )}
      <div className="space-y-3 p-4 sm:p-5">
        {teams.map((team) => {
          const currentTeamMembers = teamMembers[team.id] ?? [];
          const currentIds = new Set(currentTeamMembers.map((member) => member.developer_id));
          const availableMembers = members.filter((member) => !currentIds.has(member.developer_id));
          const isEditing = editingTeamId === team.id;
          return (
            <article key={team.id} className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                {isEditing ? (
                  <div className="grid flex-1 gap-2 md:grid-cols-[14rem_minmax(0,1fr)]">
                    <input
                      value={editingTeamDraft.name}
                      onChange={(event) => onEditingTeamDraftChange({ ...editingTeamDraft, name: event.target.value })}
                      className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                    />
                    <input
                      value={editingTeamDraft.description}
                      onChange={(event) => onEditingTeamDraftChange({ ...editingTeamDraft, description: event.target.value })}
                      className="h-9 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                    />
                  </div>
                ) : (
                  <div className="min-w-0">
                    <h3 className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{team.name}</h3>
                    <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{team.description || 'No description'}</p>
                    <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{currentTeamMembers.length} member{currentTeamMembers.length === 1 ? '' : 's'}</p>
                  </div>
                )}
                {canManage && (
                  <div className="flex shrink-0 items-center gap-2">
                    {isEditing ? (
                      <>
                        <button type="button" onClick={() => onUpdateTeam(team)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                          <Check size={14} />
                          Save
                        </button>
                        <button type="button" onClick={onCancelEditingTeam} className="h-8 rounded-lg px-2.5 text-xs font-medium text-zinc-500 hover:bg-white dark:text-zinc-400 dark:hover:bg-zinc-800">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => onStartEditingTeam(team)} className="h-8 rounded-lg px-2.5 text-xs font-medium text-zinc-500 hover:bg-white dark:text-zinc-400 dark:hover:bg-zinc-800">
                          Edit
                        </button>
                        <IconButton label={`Delete ${team.name}`} onClick={() => onDeleteTeam(team)}>
                          <Trash2 size={14} />
                        </IconButton>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {currentTeamMembers.map((member) => (
                  <span key={member.developer_id} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                    <span className="truncate">{member.email}</span>
                    {canManage && (
                      <button type="button" onClick={() => onRemoveTeamMember(team, member)} className="text-zinc-400 hover:text-red-500" aria-label={`Remove ${member.email} from ${team.name}`}>
                        <Trash2 size={12} />
                      </button>
                    )}
                  </span>
                ))}
                {currentTeamMembers.length === 0 && <span className="text-xs text-zinc-400 dark:text-zinc-500">No team members</span>}
              </div>
              {canManage && availableMembers.length > 0 && (
                <select
                  value=""
                  onChange={(event) => onAddTeamMember(team, event.target.value)}
                  aria-label={`Add member to ${team.name}`}
                  className="mt-3 h-8 rounded-lg border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                >
                  <option value="">Add member</option>
                  {availableMembers.map((member) => (
                    <option key={member.developer_id} value={member.developer_id}>
                      {memberById.get(member.developer_id)?.email ?? member.email}
                    </option>
                  ))}
                </select>
              )}
            </article>
          );
        })}
        {teams.length === 0 && <EmptyState label={canManage ? 'Create a team to start grouping members.' : 'You are not assigned to any teams.'} />}
      </div>
    </section>
  );
}

function SettingsTab({
  canEdit,
  draft,
  onDraftChange,
  onSave,
}: {
  canEdit: boolean;
  draft: OrganizationSettingsDraft;
  onDraftChange: (draft: OrganizationSettingsDraft) => void;
  onSave: (event: FormEvent) => void;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900 sm:p-5">
      <div className="flex items-start gap-3">
        <Shield size={18} className="mt-0.5 text-zinc-500 dark:text-zinc-400" />
        <div>
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Organization settings</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Admins can update the public organization name and contact email.
          </p>
        </div>
      </div>
      <form onSubmit={onSave} className="mt-4 grid max-w-2xl gap-3">
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Name</span>
          <input
            value={draft.name}
            onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
            disabled={!canEdit}
            className="h-10 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Contact email</span>
          <input
            type="email"
            value={draft.contactEmail}
            onChange={(event) => onDraftChange({ ...draft, contactEmail: event.target.value })}
            disabled={!canEdit}
            className="h-10 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
          />
        </label>
        {canEdit ? (
          <button type="submit" className="mt-1 inline-flex h-9 w-fit items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-600 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700">
            <Check size={14} />
            Save changes
          </button>
        ) : (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">Only organization admins can edit these settings.</p>
        )}
      </form>
    </section>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{description}</p>
    </div>
  );
}

function RoleBadge({ role }: { role: OrganizationRole }) {
  return (
    <span className="inline-flex w-fit items-center rounded-md bg-zinc-200 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
      {roleLabel(role)}
    </span>
  );
}

function SmallBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
      {children}
    </span>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 bg-white text-zinc-500 shadow-sm transition-colors hover:bg-zinc-50 hover:text-red-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700 dark:hover:text-red-300"
    >
      {children}
    </button>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="px-4 py-8 text-center text-sm text-zinc-400 dark:text-zinc-500 sm:px-5">
      {label}
    </div>
  );
}
