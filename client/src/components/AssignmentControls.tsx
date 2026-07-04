import { useEffect, useMemo, useState } from 'react';
import { Loader2, UserRound, UsersRound } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useOrganizations } from '../auth/OrganizationContext';
import {
  fetchOrganizationMembers,
  fetchTeamMembers,
  fetchTeams,
  type OrganizationMemberResponse,
  type TeamMemberResponse,
  type TeamResponse,
} from '../lib/auth-api';

interface AssignmentControlsProps {
  teamId: string;
  assigneeEmail: string;
  disabled?: boolean;
  compact?: boolean;
  onTeamChange: (teamId: string) => void;
  onAssigneeChange: (email: string) => void;
}

function memberLabel(member: OrganizationMemberResponse): string {
  return member.first_name?.trim() || member.last_name?.trim() || member.email;
}

export function AssignmentControls({
  teamId,
  assigneeEmail,
  disabled = false,
  compact = false,
  onTeamChange,
  onAssigneeChange,
}: AssignmentControlsProps) {
  const { accessToken } = useAuth();
  const { selectedOrganization } = useOrganizations();
  const [members, setMembers] = useState<OrganizationMemberResponse[]>([]);
  const [teams, setTeams] = useState<TeamResponse[]>([]);
  const [teamMembers, setTeamMembers] = useState<Record<string, TeamMemberResponse[]>>({});
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!accessToken || !selectedOrganization) {
      setMembers([]);
      setTeams([]);
      setTeamMembers({});
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    Promise.all([
      fetchOrganizationMembers(accessToken, selectedOrganization.organization_id),
      fetchTeams(accessToken, selectedOrganization.organization_id),
    ])
      .then(async ([nextMembers, nextTeams]) => {
        const entries = await Promise.all(
          nextTeams.map(async (team) => [
            team.id,
            await fetchTeamMembers(accessToken, selectedOrganization.organization_id, team.id),
          ] as const),
        );
        if (cancelled) return;
        setMembers(nextMembers);
        setTeams(nextTeams);
        setTeamMembers(Object.fromEntries(entries));
      })
      .catch(() => {
        if (cancelled) return;
        // Keep existing data on error to avoid clearing user's current selection
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, selectedOrganization]);

  const assigneeOptions = useMemo(() => {
    if (!teamId) return members;
    const allowedIds = new Set((teamMembers[teamId] ?? []).map((member) => member.developer_id));
    return members.filter((member) => allowedIds.has(member.developer_id));
  }, [members, teamId, teamMembers]);

  useEffect(() => {
    if (isLoading || teams.length === 0) return;
    if (!teamId) return;
    if (teams.some((team) => team.id === teamId)) return;
    onTeamChange('');
  }, [isLoading, teams, teamId, onTeamChange]);

  useEffect(() => {
    if (isLoading || members.length === 0) return;
    if (!assigneeEmail) return;
    if (assigneeOptions.some((member) => member.email === assigneeEmail)) return;
    onAssigneeChange('');
  }, [isLoading, members, assigneeEmail, assigneeOptions, onAssigneeChange]);

  const selectClass = compact
    ? 'h-8 rounded-lg border border-zinc-200 bg-white px-2 pr-7 text-xs font-medium text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
    : 'h-9 rounded-lg border border-zinc-200 bg-white px-2.5 pr-7 text-xs font-medium text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <label className="inline-flex min-w-0 items-center gap-1.5">
        <UsersRound size={14} className="shrink-0 text-zinc-400" />
        <select
          value={teamId}
          onChange={(event) => onTeamChange(event.target.value)}
          disabled={disabled || isLoading}
          aria-label="Task team"
          className={selectClass}
        >
          <option value="">No team</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>{team.name}</option>
          ))}
        </select>
      </label>
      <label className="inline-flex min-w-0 items-center gap-1.5">
        <UserRound size={14} className="shrink-0 text-zinc-400" />
        <select
          value={assigneeEmail}
          onChange={(event) => onAssigneeChange(event.target.value)}
          disabled={disabled || isLoading}
          aria-label="Task assignee"
          className={selectClass}
        >
          <option value="">Unassigned</option>
          {assigneeOptions.map((member) => (
            <option key={member.developer_id} value={member.email}>{memberLabel(member)}</option>
          ))}
        </select>
      </label>
      {isLoading && <Loader2 size={14} className="animate-spin text-zinc-400" />}
    </div>
  );
}
