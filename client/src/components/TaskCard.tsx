import { useCallback, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { Loader2, MoreHorizontal } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Task } from '@shared/types';
import { timeAgo } from '../lib/format';
import { hasUnseenAgentResponse } from '../lib/taskState';
import { TaskContextMenu } from './TaskContextMenu';

function compactIdentity(firstName: string | null, lastName: string | null, email: string | null): string {
  const first = firstName?.trim();
  if (first) return first;
  const last = lastName?.trim();
  if (last) return last;
  if (!email) return '';
  return email.split('@')[0] || email;
}

function TaskCardBody({ task, isStreaming = false }: { task: Task; isStreaming?: boolean }) {
  const isUnseen = hasUnseenAgentResponse(task);
  const assigneeLabel = task.assignee_email || task.assignee_first_name
    ? compactIdentity(task.assignee_first_name, task.assignee_last_name, task.assignee_email)
    : '';
  const creatorLabel = compactIdentity(task.creator_first_name, task.creator_last_name, task.creator_email);
  const timeRowClass = isStreaming
    ? 'font-semibold text-zinc-600 dark:text-zinc-300'
    : isUnseen
      ? 'font-semibold text-zinc-700 dark:text-zinc-200'
      : 'text-zinc-400 dark:text-zinc-500';

  return (
    <div>
      <p
        className={`text-sm text-zinc-900 dark:text-zinc-100 line-clamp-2 ${
          isUnseen ? 'font-semibold' : 'font-medium'
        }`}
      >
        {task.title}
      </p>
      {task.description && (
        <p
          className={`mt-1 text-xs line-clamp-1 ${
            isUnseen
              ? 'text-zinc-600 dark:text-zinc-300'
              : 'text-zinc-500 dark:text-zinc-400'
          }`}
        >
          {task.description}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] leading-none text-zinc-500 dark:text-zinc-400">
        {task.assignee_email && (
          <span className="max-w-full truncate rounded-md bg-zinc-100 px-1.5 py-1 dark:bg-zinc-800" title={task.assignee_email}>
            {assigneeLabel}
          </span>
        )}
        {task.team_name && (
          <span className="max-w-full truncate rounded-md bg-sky-50 px-1.5 py-1 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300" title={task.team_name}>
            {task.team_name}
          </span>
        )}
        {creatorLabel && (
          <span className="max-w-full truncate rounded-md bg-zinc-100 px-1.5 py-1 dark:bg-zinc-800" title={task.creator_email ?? undefined}>
            by {creatorLabel}
          </span>
        )}
      </div>
      <div
        className={`mt-3 flex items-center gap-1.5 text-[11px] leading-none ${timeRowClass}`}
      >
        {isStreaming ? (
          <Loader2 size={12} className="shrink-0 animate-spin" strokeWidth={2.5} />
        ) : isUnseen && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-700 ring-4 ring-zinc-100 dark:bg-zinc-200 dark:ring-zinc-800" />
        )}
        <span>{isStreaming ? 'Working...' : timeAgo(task.updated_at)}</span>
      </div>
    </div>
  );
}

export function TaskCard({
  task,
  isStreaming = false,
  onRequestStart,
}: {
  task: Task;
  isStreaming?: boolean;
  onRequestStart?: (task: Task) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    isDragging,
  } = useDraggable({ id: task.id, data: { task } });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const isUnseen = hasUnseenAgentResponse(task);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleMenuButtonClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu((current) => (
      current ? null : { x: rect.left, y: rect.bottom + 6 }
    ));
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const stopPropagation = useCallback((e: { stopPropagation(): void }) => {
    e.stopPropagation();
  }, []);

  return (
    <>
      <div
        ref={setNodeRef}
        onContextMenu={handleContextMenu}
        className={`group/card relative rounded-lg bg-white dark:bg-zinc-900 border cursor-grab active:cursor-grabbing select-none transition-[opacity,box-shadow,border-color] duration-150 ${
          isDragging
            ? 'opacity-30 border-dashed border-zinc-300 dark:border-zinc-600 shadow-none'
            : isUnseen
              ? 'border-zinc-400 dark:border-zinc-600 shadow-lg hover:shadow-xl hover:border-zinc-400 dark:hover:border-zinc-500'
              : 'border-zinc-200 dark:border-zinc-800 shadow-sm hover:shadow-md hover:border-zinc-300 dark:hover:border-zinc-700'
        }`}
      >
        <Link
          to={`/tasks/${task.id}`}
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="block p-3.5 pr-8 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60 dark:focus-visible:ring-zinc-500/70"
        >
          <TaskCardBody task={task} isStreaming={isStreaming} />
        </Link>
        <button
          type="button"
          onPointerDown={stopPropagation}
          onMouseDown={stopPropagation}
          onClick={handleMenuButtonClick}
          aria-label={`Actions for ${task.title}`}
          aria-haspopup="menu"
          aria-expanded={contextMenu !== null}
          title="Task actions"
          className="absolute right-2 top-2 h-7 w-7 cursor-pointer inline-flex items-center justify-center rounded-md border border-transparent bg-white/85 text-zinc-400 hover:text-zinc-700 hover:border-zinc-200 hover:bg-white dark:bg-zinc-900/85 dark:text-zinc-500 dark:hover:text-zinc-200 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400/60 dark:focus-visible:ring-zinc-500/70 transition-[background-color,border-color,color,opacity]"
        >
          <MoreHorizontal size={17} strokeWidth={2.5} />
        </button>
      </div>
      {contextMenu && (
        <TaskContextMenu
          task={task}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          onRequestStart={onRequestStart}
        />
      )}
    </>
  );
}

export function TaskCardOverlay({ task, isStreaming = false }: { task: Task; isStreaming?: boolean }) {
  return (
    <div className="p-3.5 rounded-lg bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-600 shadow-2xl rotate-[2deg] scale-105 w-[280px] pointer-events-none">
      <TaskCardBody task={task} isStreaming={isStreaming} />
    </div>
  );
}
