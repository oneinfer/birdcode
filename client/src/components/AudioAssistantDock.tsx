import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, Download, Loader2, Mic, MicOff, Volume2, VolumeX, X } from 'lucide-react';
import {
  apiAuthHeaders,
  BASE,
  fetchAudioAssistantRuntimeStatus,
  installAudioAssistantRuntime,
  liveTaskChatUrl,
  liveTaskTtsUrl,
  startActivityAssistant,
  stopActivityAssistant,
  transcribeAudio,
  type AsrStatusResponse,
  type TtsStatusResponse,
} from '../lib/api';
import { toErrorMessage } from '../lib/format';
import { useStore } from '../lib/store';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { AudioQueue, BrowserSpeechQueue } from '../lib/audioPlayback';

const ASSISTANT_TASK_KEY = 'bees:audioAssistantTaskId';

type TtsEvent =
  | { type: 'ready'; enabled?: boolean; available?: boolean; error?: string }
  | { type: 'audio'; audioBase64: string; sampleRate: number; sampleCount?: number; segmentId?: number }
  | { type: 'dropped'; count?: number }
  | { type: 'error'; error?: string }
  | { type: 'end' };

type ChatLiveEvent =
  | { type: 'snapshot' }
  | { type: 'text_delta'; content?: string }
  | { type: 'done' }
  | { type: 'error'; error?: string };

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return match ? decodeURIComponent(match.slice(prefix.length)) : null;
}

export function AudioAssistantDock() {
  const tasks = useStore((s) => s.tasks);
  const activeTasks = useMemo(
    () => tasks
      .filter((task) => task.status === 'in_progress')
      .sort((a, b) => b.updated_at - a.updated_at),
    [tasks],
  );
  const [expanded, setExpanded] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState(() => {
    try {
      return localStorage.getItem(ASSISTANT_TASK_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [ttsStatus, setTtsStatus] = useState<TtsStatusResponse | null>(null);
  const [asrStatus, setAsrStatus] = useState<AsrStatusResponse | null>(null);
  const [status, setStatus] = useState('Audio assistant idle');
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [daemonPending, setDaemonPending] = useState(false);
  const [runtimeInstalling, setRuntimeInstalling] = useState(false);
  const ttsSourceRef = useRef<EventSource | null>(null);
  const chatSpeechSourceRef = useRef<EventSource | null>(null);
  const audioQueueRef = useRef(new AudioQueue());
  const browserSpeechRef = useRef(new BrowserSpeechQueue());

  const selectedTask = useMemo(
    () => activeTasks.find((task) => task.id === selectedTaskId) ?? activeTasks[0] ?? null,
    [activeTasks, selectedTaskId],
  );
  const effectiveTaskId = selectedTask?.id ?? '';

  useEffect(() => {
    if (!selectedTaskId && activeTasks[0]) setSelectedTaskId(activeTasks[0].id);
  }, [activeTasks, selectedTaskId]);

  useEffect(() => {
    try {
      if (effectiveTaskId) localStorage.setItem(ASSISTANT_TASK_KEY, effectiveTaskId);
    } catch {
      // Local persistence is convenience only.
    }
  }, [effectiveTaskId]);

  const setAudioAssistantEnabled = useCallback((next: boolean) => {
    setAudioEnabled(next);
    setError(null);
    setDaemonPending(true);
    const daemonRequest = next ? startActivityAssistant() : stopActivityAssistant();
    daemonRequest
      .catch((err) => {
        setError(toErrorMessage(err, next ? 'Failed to start audio assistant' : 'Failed to stop audio assistant'));
      })
      .finally(() => setDaemonPending(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAudioAssistantRuntimeStatus()
      .then((nextStatus) => {
        if (cancelled) return;
        setAsrStatus(nextStatus.asr);
        setTtsStatus(nextStatus.tts);
      })
      .catch((err) => {
        if (!cancelled) setError(toErrorMessage(err, 'Audio output is unavailable'));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    ttsSourceRef.current?.close();
    ttsSourceRef.current = null;
    audioQueueRef.current.reset();

    if (!audioEnabled || !effectiveTaskId) return undefined;

    const source = new EventSource(liveTaskTtsUrl(effectiveTaskId));
    ttsSourceRef.current = source;
    source.onmessage = (message) => {
      let event: TtsEvent;
      try {
        event = JSON.parse(message.data) as TtsEvent;
      } catch {
        return;
      }

      if (event.type === 'ready') {
        if (event.available === false) setError(event.error || 'Audio output is unavailable');
        else setStatus('Listening');
        return;
      }
      if (event.type === 'audio') {
        void audioQueueRef.current.play(event.audioBase64, event.sampleRate).catch((err) => {
          setError(toErrorMessage(err, 'Audio playback failed'));
        });
        return;
      }
      if (event.type === 'error') setError(event.error || 'Audio output failed');
    };
    source.onerror = () => {};

    return () => {
      source.close();
      if (ttsSourceRef.current === source) ttsSourceRef.current = null;
    };
  }, [audioEnabled, effectiveTaskId]);

  const inputReady = !!asrStatus?.enabled && !!asrStatus.available;
  const outputReady = !!ttsStatus?.enabled && !!ttsStatus.available;
  const browserSpeechReady = browserSpeechRef.current.available();
  const audioOutputReady = outputReady || browserSpeechReady;
  const canRecord = audioEnabled && !!effectiveTaskId && !isSending && inputReady && audioOutputReady;
  const compactTitle = audioEnabled ? 'Audio assistant' : 'Enable audio assistant';
  const needsRuntimeInstall = !inputReady || !ttsStatus?.enabled;

  const installRuntime = useCallback(async () => {
    if (runtimeInstalling) return;
    setRuntimeInstalling(true);
    setError(null);
    setStatus('Installing speech dependencies');
    try {
      const nextStatus = await installAudioAssistantRuntime();
      setAsrStatus(nextStatus.asr);
      setTtsStatus(nextStatus.tts);
      setStatus(nextStatus.asr.available ? 'Audio assistant ready' : 'Speech input unavailable');
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to install speech dependencies'));
      await fetchAudioAssistantRuntimeStatus()
        .then((nextStatus) => {
          setAsrStatus(nextStatus.asr);
          setTtsStatus(nextStatus.tts);
        })
        .catch(() => undefined);
    } finally {
      setRuntimeInstalling(false);
    }
  }, [runtimeInstalling]);

  useEffect(() => {
    chatSpeechSourceRef.current?.close();
    chatSpeechSourceRef.current = null;
    browserSpeechRef.current.reset();

    if (!audioEnabled || !effectiveTaskId || outputReady || !browserSpeechRef.current.available()) return undefined;

    const source = new EventSource(liveTaskChatUrl(effectiveTaskId));
    chatSpeechSourceRef.current = source;
    source.onmessage = (message) => {
      let event: ChatLiveEvent;
      try {
        event = JSON.parse(message.data) as ChatLiveEvent;
      } catch {
        return;
      }

      if (event.type === 'text_delta' && event.content) {
        browserSpeechRef.current.acceptText(event.content);
        return;
      }
      if (event.type === 'done') browserSpeechRef.current.acceptText('', true);
      if (event.type === 'error') setError(event.error || 'Assistant stream failed');
    };
    source.onerror = () => {};

    return () => {
      source.close();
      if (chatSpeechSourceRef.current === source) chatSpeechSourceRef.current = null;
    };
  }, [audioEnabled, effectiveTaskId, outputReady]);

  useEffect(() => () => {
    ttsSourceRef.current?.close();
    chatSpeechSourceRef.current?.close();
    audioQueueRef.current.close();
    browserSpeechRef.current.reset();
  }, []);

  const sendTranscript = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || !effectiveTaskId) return;
    setIsSending(true);
    setStatus('Sending');
    setError(null);
    try {
      const res = await fetch(`${BASE}/tasks/${encodeURIComponent(effectiveTaskId)}/messages`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...apiAuthHeaders(),
          ...(readCookie('bees_csrf_token') ? { 'X-CSRF-Token': readCookie('bees_csrf_token')! } : {}),
        },
        body: JSON.stringify({ content }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setStatus('Assistant responding');
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to send voice message'));
    } finally {
      setIsSending(false);
    }
  }, [effectiveTaskId]);

  const recorder = useVoiceRecorder(
    () => undefined,
    async (audio) => {
      setStatus('Transcribing');
      setError(null);
      const result = await transcribeAudio(audio);
      const text = result.text.trim();
      if (!text) {
        setError('No speech was detected.');
        setStatus('Listening');
        return;
      }
      await sendTranscript(text);
    },
  );

  useEffect(() => {
    if (recorder.error) setError(recorder.error);
  }, [recorder.error]);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title={compactTitle}
        aria-label={compactTitle}
        className="fixed bottom-5 right-5 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-700 shadow-lg transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
      >
        <Bot size={20} />
      </button>
    );
  }

  return (
    <section className="fixed bottom-5 right-5 z-40 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2 dark:border-zinc-800">
        <Bot size={17} className="shrink-0 text-zinc-500 dark:text-zinc-400" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">Audio assistant</p>
          <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{status}</p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          title="Collapse"
          aria-label="Collapse audio assistant"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <ChevronDown size={16} />
        </button>
        <button
          type="button"
          onClick={() => {
            setAudioAssistantEnabled(false);
            setExpanded(false);
          }}
          title="Close"
          aria-label="Close audio assistant"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <X size={16} />
        </button>
      </div>

      <div className="space-y-3 p-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-500 dark:text-zinc-400">Assistant task</span>
          <select
            value={effectiveTaskId}
            onChange={(event) => setSelectedTaskId(event.target.value)}
            disabled={activeTasks.length === 0}
            className="h-9 w-full rounded-lg border border-zinc-200 bg-white px-2 text-sm text-zinc-800 outline-none transition focus:border-zinc-400 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-zinc-500"
          >
            {activeTasks.length === 0 ? (
              <option value="">Start a task first</option>
            ) : activeTasks.map((task) => (
              <option key={task.id} value={task.id}>{task.title}</option>
            ))}
          </select>
        </label>

        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={daemonPending || runtimeInstalling}
            onClick={() => setAudioAssistantEnabled(!audioEnabled)}
            aria-pressed={audioEnabled}
            className={`inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${
              audioEnabled
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-800'
            }`}
          >
            {daemonPending ? <Loader2 size={15} className="animate-spin" /> : audioEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
            <span>{audioEnabled ? 'Audio on' : 'Audio off'}</span>
          </button>

          <button
            type="button"
            disabled={!canRecord || recorder.isTranscribing}
            onClick={() => {
              if (recorder.isRecording) recorder.stop();
              else void recorder.start();
            }}
            aria-pressed={recorder.isRecording}
            title={recorder.isRecording ? 'Stop recording' : 'Record'}
            className={`inline-flex h-11 w-11 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${
              recorder.isRecording
                ? 'bg-red-600 text-white hover:bg-red-700'
                : 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-950 dark:hover:bg-zinc-300'
            }`}
          >
            {recorder.isTranscribing || isSending ? (
              <Loader2 size={18} className="animate-spin" />
            ) : recorder.isRecording ? (
              <MicOff size={18} />
            ) : (
              <Mic size={18} />
            )}
          </button>
        </div>

        {needsRuntimeInstall && (
          <button
            type="button"
            disabled={runtimeInstalling}
            onClick={() => void installRuntime()}
            title="Install speech dependencies"
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            {runtimeInstalling ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
            <span>{runtimeInstalling ? 'Installing speech dependencies' : 'Install speech dependencies'}</span>
          </button>
        )}

        {!inputReady && audioEnabled && (
          <p className="text-xs text-amber-600 dark:text-amber-300">
            {asrStatus?.error || 'Speech input dependencies are not installed.'}
          </p>
        )}
        {!outputReady && audioEnabled && !browserSpeechReady && (
          <p className="text-xs text-amber-600 dark:text-amber-300">
            {ttsStatus?.error || 'Audio output is not available.'}
          </p>
        )}
        {!outputReady && audioEnabled && browserSpeechReady && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Using browser voice output.</p>
        )}
        {!effectiveTaskId && (
          <p className="text-xs text-amber-600 dark:text-amber-300">Start a task to use audio chat.</p>
        )}
        {error && <p className="text-xs text-red-500 dark:text-red-400">{error}</p>}
      </div>
    </section>
  );
}
