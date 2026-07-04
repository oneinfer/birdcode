import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, Sparkles, Zap, type LucideIcon } from 'lucide-react';
import { REASONING_EFFORTS, type AgentDefaults, type AgentModelGroup, type AgentModelPricing, type AgentRuntime, type AgentRuntimeOption, type ContextUsage, type ReasoningEffort } from '@shared/types';
import { formatTokenCount } from '../lib/format';

export function ContextRing({ context }: { context: ContextUsage }) {
  const pct = context.window_tokens > 0
    ? Math.round((context.used_tokens / context.window_tokens) * 100)
    : 0;
  const clampedPct = Math.min(Math.max(pct, 0), 100);

  const size = 26;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clampedPct / 100);

  const exceeded = pct > 100;
  let colorClass: string;
  if (pct > 85) colorClass = 'text-red-500';
  else if (pct > 60) colorClass = 'text-amber-500';
  else colorClass = 'text-zinc-400 dark:text-zinc-500';

  return (
    <div className="relative group cursor-default">
      <div className="relative w-[26px] h-[26px]">
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-zinc-200 dark:stroke-zinc-700"
          />
          {pct > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              stroke="currentColor"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              strokeLinecap="round"
              className={`${colorClass} transition-[stroke-dashoffset] duration-700 ease-out`}
            />
          )}
        </svg>
        <span
          className={`absolute inset-0 flex items-center justify-center text-[9px] font-semibold tabular-nums leading-none ${colorClass}`}
        >
          {pct}
        </span>
      </div>

      <div className="absolute bottom-full right-0 mb-2.5 z-50 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity duration-150">
        <div className="w-56 p-3 rounded-lg bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-lg">
          <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 mb-1">
            Context window
          </p>
          {exceeded && (
            <p className="text-xs text-red-500 mb-0.5">{pct}% used (exceeded)</p>
          )}
          <div className="space-y-0.5 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
            <p>Context: {formatTokenCount(context.used_tokens)} / {formatTokenCount(context.window_tokens)}</p>
          </div>
        </div>
        <div className="absolute -bottom-[3px] right-[9px] w-1.5 h-1.5 bg-white dark:bg-zinc-800 border-r border-b border-zinc-200 dark:border-zinc-700 rotate-45" />
      </div>
    </div>
  );
}

export const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
};

const MODEL_PICKER_DEFAULT_GROUP_ID = 'special:default';
const MODEL_PICKER_RECENT_GROUP_ID = 'special:recent';
const MODEL_PICKER_SEARCH_GROUP_ID = 'special:search';
const MODEL_PICKER_MIN_WIDTH = 620;
const MODEL_PICKER_MAX_HEIGHT = 410;
const RECENT_MODELS_STORAGE_KEY = 'bees.recentModels';
const MAX_RECENT_MODELS = 5;

function parseSearchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAllTerms(searchable: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const lower = searchable.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

interface ToolbarSelectOption {
  value: string;
  label: string;
  group?: string;
}

interface ToolbarSelectProps {
  icon: LucideIcon;
  value: string;
  options: ToolbarSelectOption[];
  disabled?: boolean;
  title: string;
  labelMaxWidthClass?: string;
  minMenuWidth?: number;
  searchable?: boolean;
  searchPlaceholder?: string;
  onChange: (value: string) => void;
}

export function ToolbarSelect({
  icon: Icon,
  value,
  options,
  disabled = false,
  title,
  labelMaxWidthClass = 'max-w-[11rem] sm:max-w-[14rem]',
  minMenuWidth = 180,
  searchable = false,
  searchPlaceholder = 'Search...',
  onChange,
}: ToolbarSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const activeIndexRef = useRef(0);
  activeIndexRef.current = activeIndex;

  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options[selectedIndex] ?? options[0];
  const filteredOptions = useMemo(() => {
    if (!searchable) return options;

    const terms = parseSearchTerms(query);
    if (terms.length === 0) return options;

    return options.filter((option) =>
      matchesAllTerms([option.label, option.value, option.group ?? ''].join(' '), terms),
    );
  }, [options, query, searchable]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const padding = 8;
    const gap = 8;
    const rect = trigger.getBoundingClientRect();
    const menuHeight = menuRef.current?.offsetHeight ?? 260;
    const width = Math.min(
      Math.max(rect.width, minMenuWidth),
      window.innerWidth - padding * 2,
    );
    const left = Math.min(
      Math.max(rect.left, padding),
      window.innerWidth - width - padding,
    );

    const top = Math.max(padding, rect.top - menuHeight - gap);

    setMenuStyle((prev) => {
      if (prev && prev.left === left && prev.top === top && prev.width === width) return prev;
      return { position: 'fixed', zIndex: 50, left, top, width };
    });
  }, [minMenuWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [filteredOptions.length, open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    setQuery('');

    if (searchable) {
      window.requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const nextSelectedIndex = filteredOptions.findIndex((option) => option.value === value);
    setActiveIndex(Math.max(0, nextSelectedIndex));
  }, [filteredOptions, open, value]);

  const choose = useCallback((option: ToolbarSelectOption) => {
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }, [onChange]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      const isSearchField = event.target === searchRef.current;

      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }

      if (isSearchField && !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => Math.min(current + 1, Math.max(filteredOptions.length - 1, 0)));
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (event.key === 'Home') {
        event.preventDefault();
        setActiveIndex(0);
        return;
      }

      if (event.key === 'End') {
        event.preventDefault();
        setActiveIndex(Math.max(filteredOptions.length - 1, 0));
        return;
      }

      if (event.key === 'Enter' || event.key === ' ') {
        if (isSearchField && event.key === ' ') return;
        event.preventDefault();
        const next = filteredOptions[activeIndexRef.current];
        if (!next) return;
        choose(next);
      }
    }

    document.addEventListener('mousedown', handlePointerDown, { passive: true });
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition, { passive: true });
    window.addEventListener('scroll', updatePosition, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [choose, filteredOptions, open, updatePosition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70"
      >
        <Icon size={12} className="shrink-0" />
        <span className={`min-w-0 truncate ${labelMaxWidthClass}`}>
          {selectedOption?.label ?? 'Select'}
        </span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-zinc-400 transition-transform dark:text-zinc-500 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          style={menuStyle ?? { position: 'fixed', left: -9999, top: -9999, zIndex: 50 }}
          className="rounded-xl border border-zinc-200 bg-white py-1.5 shadow-xl outline-none dark:border-zinc-700 dark:bg-zinc-900"
        >
          {searchable && (
            <div className="px-2 pb-1.5">
              <div className="flex h-9 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                <Search size={14} className="shrink-0" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                />
              </div>
            </div>
          )}

          <div
            id={menuId}
            role="listbox"
            aria-activedescendant={filteredOptions.length > 0 ? `${menuId}-${activeIndex}` : undefined}
            className="max-h-64 overflow-y-auto"
          >
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-5 text-center text-xs text-zinc-400 dark:text-zinc-500">
                No matches
              </div>
            ) : (
              filteredOptions.map((option, index) => {
                const previousGroup = index > 0 ? filteredOptions[index - 1].group : undefined;
                const showGroup = option.group && option.group !== previousGroup;
                const selected = option.value === value;
                const active = index === activeIndex;

                return (
                  <Fragment key={`${option.group ?? 'root'}:${option.value}`}>
                    {showGroup && (
                      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                        {option.group}
                      </div>
                    )}
                    <button
                      id={`${menuId}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => choose(option)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                        active
                          ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                          : 'text-zinc-700 dark:text-zinc-300'
                      }`}
                    >
                      <Check
                        size={14}
                        className={`shrink-0 ${selected ? 'opacity-100' : 'opacity-0'}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    </button>
                  </Fragment>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

interface ModelPickerItem {
  value: string;
  label: string;
  provider: string;
  isCurrentDefault?: boolean;
  pricing?: AgentModelPricing;
}

interface ModelPickerGroup {
  id: string;
  label: string;
  kind: 'default' | 'recent' | 'provider' | 'search';
  models: ModelPickerItem[];
}

export interface ModelPickerProps {
  value: string;
  defaultModel: string | null;
  modelGroups: AgentModelGroup[];
  disabled?: boolean;
  title: string;
  recentScope?: string;
  showInheritOption?: boolean;
  onChange: (value: string) => void;
}

function formatProviderLabel(provider: string): string {
  if (provider === 'aliases') return 'Aliases';
  if (provider.startsWith('custom:')) {
    return `Custom: ${formatProviderLabel(provider.slice('custom:'.length))}`;
  }

  return provider
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function providerGroupId(provider: string): string {
  return `provider:${provider}`;
}

function recentModelsStorageKey(scope?: string): string {
  return scope ? `${RECENT_MODELS_STORAGE_KEY}:${scope}` : RECENT_MODELS_STORAGE_KEY;
}

function readRecentModels(scope?: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(recentModelsStorageKey(scope)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, MAX_RECENT_MODELS);
  } catch {
    return [];
  }
}

function writeRecentModels(modelIds: string[], scope?: string) {
  try {
    localStorage.setItem(recentModelsStorageKey(scope), JSON.stringify(modelIds.slice(0, MAX_RECENT_MODELS)));
  } catch {
    // Recent models are a convenience only.
  }
}

function modelMatchesTerms(model: ModelPickerItem, terms: string[]): boolean {
  return matchesAllTerms([model.label, model.value, model.provider].join(' '), terms);
}

function modelRowKey(model: ModelPickerItem): string {
  return `${model.provider}:${model.value}`;
}

function formatUsdPrice(value: number): string {
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: digits,
  })}`;
}

function pricingUnitLabel(pricing: AgentModelPricing): string {
  switch (pricing.unit) {
    case 'million_tokens':
      return '1M tokens';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio_minute':
      return 'audio min';
    case 'request':
      return 'request';
    default:
      return 'unit';
  }
}

function formatModelPricing(pricing?: AgentModelPricing): string | null {
  if (!pricing) return null;
  if (pricing.display) return pricing.display;

  const unit = pricingUnitLabel(pricing);
  const input = typeof pricing.inputUsd === 'number' ? formatUsdPrice(pricing.inputUsd) : null;
  const output = typeof pricing.outputUsd === 'number' ? formatUsdPrice(pricing.outputUsd) : null;

  if (pricing.unit === 'million_tokens') {
    if (input && output) return `${input} in / ${output} out per ${unit}`;
    if (input) return `${input} in per ${unit}`;
    if (output) return `${output} out per ${unit}`;
    return `per ${unit}`;
  }

  if (input && output && input !== output) return `${input} in / ${output} out per ${unit}`;
  if (input || output) return `${input ?? output} per ${unit}`;
  return `per ${unit}`;
}

function findInitialModelGroupId(groups: ModelPickerGroup[], value: string): string {
  if (!value) return MODEL_PICKER_DEFAULT_GROUP_ID;

  return (
    groups.find((group) => group.kind === 'provider' && group.models.some((model) => model.value === value))?.id
    ?? groups.find((group) => group.kind === 'recent' && group.models.some((model) => model.value === value))?.id
    ?? groups.find((group) => group.models.some((model) => model.value === value))?.id
    ?? MODEL_PICKER_DEFAULT_GROUP_ID
  );
}

export function ModelPicker({
  value,
  defaultModel,
  modelGroups,
  disabled = false,
  title,
  recentScope,
  showInheritOption = true,
  onChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeGroupId, setActiveGroupId] = useState(MODEL_PICKER_DEFAULT_GROUP_ID);
  const [activeModelIndex, setActiveModelIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties | null>(null);
  const [recentModelIds, setRecentModelIds] = useState<string[]>([]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const activeModelIndexRef = useRef(0);
  activeModelIndexRef.current = activeModelIndex;

  const selectedModelMissing = !hasModel(modelGroups, value || null);
  const groups = useMemo<ModelPickerGroup[]>(() => {
    const defaultGroup: ModelPickerGroup = {
      id: MODEL_PICKER_DEFAULT_GROUP_ID,
      label: 'Default',
      kind: 'default',
      models: [
        {
          value: '',
          label: defaultModel ? defaultModel : 'Default',
          provider: 'Default',
        },
      ],
    };

    if (selectedModelMissing && value) {
      defaultGroup.models.push({
        value,
        label: value,
        provider: 'Current',
      });
    }

    const providerGroups: ModelPickerGroup[] = modelGroups.map((group) => {
      const providerLabel = formatProviderLabel(group.provider);
      return {
        id: providerGroupId(group.provider),
        label: providerLabel,
        kind: 'provider' as const,
        models: group.models.map((model) => ({
          value: model.id,
          label: model.label,
          provider: providerLabel,
          isCurrentDefault: model.isCurrentDefault,
          pricing: model.pricing,
        })),
      };
    });

    const modelLookup = new Map<string, ModelPickerItem>();
    for (const group of providerGroups) {
      for (const model of group.models) {
        if (!modelLookup.has(model.value)) modelLookup.set(model.value, model);
      }
    }

    const recentModels = recentModelIds
      .map((modelId) => modelLookup.get(modelId) ?? (modelId === value ? {
        value: modelId,
        label: modelId,
        provider: 'Recent',
      } : null))
      .filter((model): model is ModelPickerItem => Boolean(model));

    return [
      ...(showInheritOption ? [defaultGroup] : []),
      ...(recentModels.length > 0 ? [{
        id: MODEL_PICKER_RECENT_GROUP_ID,
        label: 'Recent',
        kind: 'recent' as const,
        models: recentModels,
      }] : []),
      ...providerGroups,
    ];
  }, [defaultModel, modelGroups, recentModelIds, selectedModelMissing, showInheritOption, value]);

  const modelLookup = useMemo(() => {
    const map = new Map<string, ModelPickerItem>();
    for (const group of groups) {
      for (const model of group.models) {
        if (!map.has(model.value)) map.set(model.value, model);
      }
    }
    return map;
  }, [groups]);

  const searchTerms = useMemo(() => parseSearchTerms(query), [query]);
  const searching = searchTerms.length > 0;
  const matchingGroups = useMemo(() => {
    if (!searching) return [];

    return groups
      .filter((group) => group.kind !== 'recent')
      .map((group) => ({
        ...group,
        models: group.models.filter((model) => modelMatchesTerms(model, searchTerms)),
      }))
      .filter((group) => group.models.length > 0);
  }, [groups, searchTerms, searching]);

  const navigationGroups = useMemo<ModelPickerGroup[]>(() => {
    if (!searching) return groups;

    const allMatches = matchingGroups.flatMap((group) => group.models);
    return [
      {
        id: MODEL_PICKER_SEARCH_GROUP_ID,
        label: 'All matches',
        kind: 'search',
        models: allMatches,
      },
      ...matchingGroups,
    ];
  }, [groups, matchingGroups, searching]);

  const activeGroup = useMemo(
    () => navigationGroups.find((group) => group.id === activeGroupId) ?? navigationGroups[0],
    [navigationGroups, activeGroupId],
  );
  const visibleModels = useMemo(() => activeGroup?.models ?? [], [activeGroup]);
  const selectedModel = modelLookup.get(value);
  const selectedLabel = (() => {
    if (selectedModel?.label) return selectedModel.label;
    if (value) return value;
    if (!showInheritOption) return 'Select model';
    return defaultModel ? defaultModel : 'Default';
  })();

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const padding = 8;
    const gap = 8;
    const rect = trigger.getBoundingClientRect();
    const maxWidth = window.innerWidth - padding * 2;
    const width = Math.min(Math.max(rect.width, MODEL_PICKER_MIN_WIDTH), maxWidth);
    const left = Math.min(
      Math.max(rect.left, padding),
      window.innerWidth - width - padding,
    );
    const maxHeight = window.innerHeight - padding * 2;
    const height = Math.min(MODEL_PICKER_MAX_HEIGHT, maxHeight);
    const aboveTop = rect.top - height - gap;
    const belowTop = rect.bottom + gap;
    const top = aboveTop >= padding
      ? aboveTop
      : Math.min(Math.max(belowTop, padding), window.innerHeight - height - padding);

    setMenuStyle((prev) => {
      if (
        prev
        && prev.left === left
        && prev.top === top
        && prev.width === width
        && prev.height === height
      ) {
        return prev;
      }

      return { position: 'fixed', zIndex: 50, left, top, width, height };
    });
  }, []);

  const choose = useCallback((model: ModelPickerItem) => {
    onChange(model.value);
    if (model.value) {
      setRecentModelIds((current) => {
        const next = [model.value, ...current.filter((modelId) => modelId !== model.value)].slice(0, MAX_RECENT_MODELS);
        writeRecentModels(next, recentScope);
        return next;
      });
    }
    setOpen(false);
    triggerRef.current?.focus();
  }, [onChange, recentScope]);

  useEffect(() => {
    setRecentModelIds(readRecentModels(recentScope));
  }, [recentScope]);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [navigationGroups.length, open, updatePosition, visibleModels.length]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveGroupId(findInitialModelGroupId(groups, value));
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [groups, open, value]);

  useEffect(() => {
    if (!open) return;
    if (navigationGroups.some((group) => group.id === activeGroupId)) return;
    setActiveGroupId(navigationGroups[0]?.id ?? MODEL_PICKER_DEFAULT_GROUP_ID);
  }, [activeGroupId, navigationGroups, open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = visibleModels.findIndex((model) => model.value === value);
    setActiveModelIndex(Math.max(0, selectedIndex));
  }, [activeGroupId, open, value, visibleModels]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      const isSearchField = event.target === searchRef.current;

      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }

      if (isSearchField && !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return;

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveModelIndex((current) => Math.min(current + 1, Math.max(visibleModels.length - 1, 0)));
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveModelIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (!isSearchField && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        const groupIndex = Math.max(0, navigationGroups.findIndex((group) => group.id === activeGroupId));
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        const nextGroup = navigationGroups[Math.min(Math.max(groupIndex + offset, 0), Math.max(navigationGroups.length - 1, 0))];
        if (nextGroup) {
          setActiveGroupId(nextGroup.id);
          setActiveModelIndex(0);
        }
        return;
      }

      if (event.key === 'Home') {
        event.preventDefault();
        setActiveModelIndex(0);
        return;
      }

      if (event.key === 'End') {
        event.preventDefault();
        setActiveModelIndex(Math.max(visibleModels.length - 1, 0));
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const next = visibleModels[activeModelIndexRef.current];
        if (!next) return;
        choose(next);
      }
    }

    document.addEventListener('mousedown', handlePointerDown, { passive: true });
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition, { passive: true });
    window.addEventListener('scroll', updatePosition, { capture: true, passive: true });
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [activeGroupId, choose, navigationGroups, open, updatePosition, visibleModels]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700/70"
      >
        <Sparkles size={12} className="shrink-0" />
        <span className="min-w-0 max-w-[13rem] truncate sm:max-w-[18rem]">
          {selectedLabel}
        </span>
        <ChevronDown
          size={13}
          className={`shrink-0 text-zinc-400 transition-transform dark:text-zinc-500 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="dialog"
          aria-label="Choose model"
          style={menuStyle ?? { position: 'fixed', left: -9999, top: -9999, zIndex: 50 }}
          className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl outline-none dark:border-zinc-700 dark:bg-zinc-900"
        >
          <div className="flex h-full overflow-hidden">
            <div className="w-36 shrink-0 overflow-y-auto border-r border-zinc-200 py-1.5 dark:border-zinc-800 sm:w-44">
              {navigationGroups.map((group) => {
                const active = group.id === activeGroup?.id;
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => {
                      setActiveGroupId(group.id);
                      setActiveModelIndex(0);
                    }}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
                      active
                        ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                        : 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800/70'
                    }`}
                  >
                    <span className="min-w-0 truncate font-medium">{group.label}</span>
                    <span className="shrink-0 tabular-nums text-zinc-400 dark:text-zinc-500">
                      {group.models.length}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="min-w-0 flex flex-1 flex-col">
              <div className="border-b border-zinc-200 p-2 dark:border-zinc-800">
                <div className="flex h-9 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                  <Search size={14} className="shrink-0" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => {
                      const nextQuery = event.target.value;
                      setQuery(nextQuery);
                      if (nextQuery.trim()) {
                        setActiveGroupId(MODEL_PICKER_SEARCH_GROUP_ID);
                        setActiveModelIndex(0);
                      }
                    }}
                    placeholder="Search models or providers..."
                    className="min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                  />
                </div>
              </div>

              <div
                role="listbox"
                aria-activedescendant={visibleModels.length > 0 ? `${menuId}-model-${activeModelIndex}` : undefined}
                className="min-h-0 flex-1 overflow-y-auto py-1.5"
              >
                {visibleModels.length === 0 ? (
                  <div className="px-3 py-8 text-center text-xs text-zinc-400 dark:text-zinc-500">
                    No matches
                  </div>
                ) : (
                  visibleModels.map((model, index) => {
                    const selected = model.value === value;
                    const active = index === activeModelIndex;
                    const pricingLabel = formatModelPricing(model.pricing);

                    return (
                      <button
                        key={`${modelRowKey(model)}:${index}`}
                        id={`${menuId}-model-${index}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onMouseEnter={() => setActiveModelIndex(index)}
                        onClick={() => choose(model)}
                        className={`flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors ${
                          active
                            ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                            : 'text-zinc-700 dark:text-zinc-300'
                        }`}
                      >
                        <Check
                          size={14}
                          className={`shrink-0 ${selected ? 'opacity-100' : 'opacity-0'}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{model.label}</span>
                          {(searching || model.value !== model.label) && (
                            <span className="block truncate text-xs text-zinc-400 dark:text-zinc-500">
                              {searching ? model.provider : model.value}
                            </span>
                          )}
                        </span>
                        {pricingLabel && (
                          <span className="shrink-0 rounded-md bg-zinc-50 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            {pricingLabel}
                          </span>
                        )}
                        {model.isCurrentDefault && (
                          <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            Default
                          </span>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

interface InputToolbarProps {
  runtime: AgentRuntime | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  defaults?: AgentDefaults | null;
  runtimeDefaultModel?: string | null;
  runtimeOptions?: AgentRuntimeOption[];
  modelGroups?: AgentModelGroup[];
  disabled?: boolean;
  onRuntimeChange: (runtime: AgentRuntime | null) => void;
  onModelChange: (model: string | null) => void;
  onReasoningEffortChange: (effort: ReasoningEffort | null) => void;
}

function hasModel(groups: AgentModelGroup[] | undefined, model: string | null): boolean {
  if (!model) return true;
  return Boolean(groups?.some((group) => group.models.some((option) => option.id === model)));
}

function LoadingToolbarButton({
  icon: Icon,
  className = '',
}: {
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <button
      type="button"
      disabled
      className={`inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-400 shadow-sm disabled:cursor-not-allowed dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500 ${className}`}
    >
      <Icon size={12} className="shrink-0" />
      <span className="h-3 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      <ChevronDown size={13} className="shrink-0 text-zinc-300 dark:text-zinc-600" />
    </button>
  );
}

function ModelTextField({
  value,
  disabled = false,
  title,
  placeholder,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  title: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label
      title={title}
      className="inline-flex h-9 max-w-full items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 text-xs font-medium text-zinc-600 shadow-sm transition-colors focus-within:border-zinc-300 focus-within:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:focus-within:border-zinc-600 dark:focus-within:bg-zinc-700/70"
    >
      <Sparkles size={12} className="shrink-0" />
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-[10rem] max-w-[14rem] bg-transparent text-xs text-zinc-700 outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed dark:text-zinc-200 dark:placeholder:text-zinc-500"
      />
    </label>
  );
}

export function InputToolbar({
  runtime,
  model,
  reasoningEffort,
  defaults,
  runtimeDefaultModel = null,
  runtimeOptions = [],
  modelGroups = [],
  disabled = false,
  onRuntimeChange,
  onModelChange,
  onReasoningEffortChange,
}: InputToolbarProps) {
  const defaultRuntime = defaults?.runtime ?? 'hermes';
  const defaultModel = defaults?.model ?? null;
  const defaultReasoning = defaults?.reasoningEffort ?? null;
  const effectiveRuntime = runtime ?? defaultRuntime;
  const runtimeMeta = runtimeOptions.find((option) => option.id === effectiveRuntime);
  const modelControl = runtimeMeta?.modelControl ?? 'picker';
  const reasoningControl = runtimeMeta?.reasoningControl ?? 'picker';
  const resolvedDefaultModel = runtimeDefaultModel ?? defaultModel;
  const shouldUsePicker = modelControl === 'picker' && (effectiveRuntime === 'hermes' || modelGroups.length > 0);
  const shouldUseTextField = modelControl === 'text' || (modelControl === 'picker' && effectiveRuntime !== 'hermes' && modelGroups.length === 0);
  const runtimeSelectOptions = useMemo<ToolbarSelectOption[]>(
    () => runtimeOptions.map((option) => ({
      value: option.id,
      label: option.status === 'ready' ? option.label : `${option.label} (Configure)`,
      group: option.status === 'ready' ? 'Ready' : 'Needs setup',
    })),
    [runtimeOptions],
  );

  const reasoningOptions = useMemo<ToolbarSelectOption[]>(() => [
    {
      value: '',
      label: defaultReasoning ? REASONING_LABELS[defaultReasoning] : 'Default',
    },
    ...REASONING_EFFORTS.map((effort) => ({
      value: effort,
      label: REASONING_LABELS[effort],
    })),
  ], [defaultReasoning]);

  if (!defaults) {
    return (
      <div className="flex items-center gap-2 min-w-0 flex-nowrap">
        <LoadingToolbarButton icon={Sparkles} className="[&>span]:w-20" />
        <LoadingToolbarButton icon={Sparkles} className="[&>span]:w-24" />
        <LoadingToolbarButton icon={Zap} className="[&>span]:w-14" />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 min-w-0 flex-nowrap">
      <ToolbarSelect
        icon={Sparkles}
        value={effectiveRuntime}
        options={runtimeSelectOptions}
        disabled={disabled || runtimeSelectOptions.length === 0}
        title={`Runtime: ${effectiveRuntime}`}
        labelMaxWidthClass="max-w-[8rem] sm:max-w-[10rem]"
        minMenuWidth={220}
        searchable
        searchPlaceholder="Search runtimes..."
        onChange={(nextRuntime) => onRuntimeChange((nextRuntime || null) as AgentRuntime | null)}
      />

      {shouldUsePicker && (
        <ModelPicker
          value={model ?? ''}
          defaultModel={resolvedDefaultModel}
          modelGroups={modelGroups}
          disabled={disabled}
          title={model ? `Model: ${model}` : resolvedDefaultModel ? `Inherits ${resolvedDefaultModel}` : 'Inherits default model'}
          recentScope={effectiveRuntime}
          onChange={(nextModel) => onModelChange(nextModel || null)}
        />
      )}

      {shouldUseTextField && (
        <ModelTextField
          value={model ?? ''}
          disabled={disabled}
          title={model ? `Model: ${model}` : 'Optional model id override'}
          placeholder="Model id (optional)"
          onChange={(nextModel) => onModelChange(nextModel.trim() || null)}
        />
      )}

      {reasoningControl === 'picker' && (
        <ToolbarSelect
          icon={Zap}
          value={reasoningEffort ?? ''}
          options={reasoningOptions}
          disabled={disabled}
          title={reasoningEffort ? `Reasoning: ${reasoningEffort}` : defaultReasoning ? `Inherits ${defaultReasoning}` : 'Inherits default reasoning'}
          minMenuWidth={180}
          onChange={(nextReasoning) => onReasoningEffortChange((nextReasoning || null) as ReasoningEffort | null)}
        />
      )}

      {modelControl === 'none' && reasoningControl === 'none' && (
        <span className="inline-flex h-9 items-center rounded-lg border border-zinc-200 bg-white px-2.5 text-xs text-zinc-500 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
          Runtime handles its own model/config
        </span>
      )}
    </div>
  );
}
