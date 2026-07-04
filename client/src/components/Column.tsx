import { useDroppable } from '@dnd-kit/core';
import { GitPullRequest, Loader2, MoreHorizontal, Play, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task, TaskStatus } from '@shared/types';
import { STATUS_META } from '../lib/constants';
import { ColumnActionsMenu } from './ColumnActionsMenu';
import { StatusIcon } from './StatusIcon';
import { TaskCard } from './TaskCard';

interface ColumnProps {
  status: TaskStatus;
  tasks: Task[];
  streamingTaskIds: Set<string>;
  isLast?: boolean;
  onRequestDeleteAll: (status: TaskStatus) => void;
  onFlushPending: () => void;
  isFlushingPending: boolean;
  onCreatePullRequestWithAi: () => void;
  isCreatingPullRequestTask: boolean;
  onRequestStart: (task: Task) => void;
}

export function Column({
  status,
  tasks,
  streamingTaskIds,
  isLast = false,
  onRequestDeleteAll,
  onFlushPending,
  isFlushingPending,
  onCreatePullRequestWithAi,
  isCreatingPullRequestTask,
  onRequestStart,
}: ColumnProps) {
  const { label } = STATUS_META[status];
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const navigate = useNavigate();
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const showAddButton = status === 'assigned' || status === 'pending' || status === 'in_progress';
  const createTaskPath = `/tasks/new?status=${status}`;
  const showFlushButton = status === 'pending';
  const showPullRequestButton = status === 'in_review';

  const openMenu = useCallback((button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setMenuPosition((current) => (
      current ? null : { x: rect.left, y: rect.bottom + 6 }
    ));
  }, []);

  return (
    <div className={`group/column flex flex-col min-w-[272px] max-w-[360px] flex-1 ${
      isLast ? 'pr-0' : 'border-r border-zinc-200 pr-6 dark:border-zinc-800'
    }`}>
      <div className="flex items-center gap-2 mb-3 pl-1">
        <StatusIcon status={status} />
        <h2 className="text-xs font-medium tracking-wider text-zinc-500 dark:text-zinc-400 uppercase">{label}</h2>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">{tasks.length}</span>
        <div className="ml-auto -mr-0.5 flex items-center gap-0.5">
          {showFlushButton && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onFlushPending}
              disabled={tasks.length === 0 || isFlushingPending}
              aria-label="Flush pending tasks"
              title="Flush pending tasks"
              className="h-6 min-w-[64px] inline-flex items-center justify-center gap-1 rounded-md px-2 text-[11px] font-medium text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:disabled:hover:text-zinc-400"
            >
              {isFlushingPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Play size={13} fill="currentColor" strokeWidth={2.5} />
              )}
              Flush
            </button>
          )}
          {showPullRequestButton && (
            <button
              type="button"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onCreatePullRequestWithAi}
              disabled={tasks.length === 0 || isCreatingPullRequestTask}
              aria-label="Create pull request with AI"
              title="Create pull request with AI"
              className="h-6 w-6 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:disabled:hover:text-zinc-400"
            >
              {isCreatingPullRequestTask ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <GitPullRequest size={16} strokeWidth={2.4} />
              )}
            </button>
          )}
          <button
            type="button"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => openMenu(e.currentTarget)}
            aria-label={`${label} actions`}
            aria-haspopup="menu"
            aria-expanded={menuPosition ? 'true' : 'false'}
            title={`${label} actions`}
            className="h-6 w-6 inline-flex items-center justify-center rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            <MoreHorizontal size={17} strokeWidth={2.5} />
          </button>
          {showAddButton && (
            <button
              type="button"
              onClick={() => navigate(createTaskPath)}
              aria-label="Create task"
              title="Create task"
              className="h-6 w-6 inline-flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
            >
              <Plus size={17} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
      <div
        ref={setNodeRef}
        className={`group/body flex flex-col gap-2 flex-1 rounded-lg transition-[background-color,box-shadow] duration-200 min-h-[120px] ${
          isOver
            ? 'bg-zinc-100/60 dark:bg-zinc-800/20 ring-2 ring-zinc-400/40'
            : ''
        }`}
      >
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            isStreaming={streamingTaskIds.has(task.id)}
            onRequestStart={onRequestStart}
          />
        ))}
        {showAddButton && (
          <div className="h-9 shrink-0">
            <button
              type="button"
              onClick={() => navigate(createTaskPath)}
              aria-label="Create task"
              title="Create task"
              className="h-9 w-full inline-flex items-center justify-center rounded-lg border border-dashed border-zinc-200 dark:border-zinc-800 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 hover:border-zinc-300 dark:hover:border-zinc-700 transition-[background-color,border-color,color]"
            >
              <Plus size={16} />
            </button>
          </div>
        )}
      </div>
      {menuPosition && (
        <ColumnActionsMenu
          x={menuPosition.x}
          y={menuPosition.y}
          columnLabel={label}
          taskCount={tasks.length}
          onClose={() => setMenuPosition(null)}
          onDeleteAll={() => onRequestDeleteAll(status)}
        />
      )}
    </div>
  );
}
