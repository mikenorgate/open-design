import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DevServerStatusResponse } from '@open-design/contracts';
import {
  fetchProjectDevServerStatus,
  projectDevServerProxyUrl,
  startProjectDevServer,
  stopProjectDevServer,
} from '../providers/registry';
import styles from './DevServerControls.module.css';

interface DevServerControlsProps {
  projectId: string;
  onRunningChange?: (running: boolean) => void;
}

type BusyAction = 'start' | 'stop' | null;

function statusLabel(status: DevServerStatusResponse | null): string {
  if (!status) return 'Dev server';
  switch (status.status) {
    case 'running':
      return status.framework ? `${status.framework} :${status.port ?? ''}` : `Running :${status.port ?? ''}`;
    case 'starting':
      return 'Starting…';
    case 'error':
      return 'Dev server error';
    case 'stopped':
    default:
      return 'Dev server';
  }
}

function friendlyError(message: string): string {
  if (message.includes('not imported from a folder')) {
    return 'This project is not linked to a React folder yet. Import or replace the project with a local React folder first.';
  }
  if (message.includes('Dev server not detected')) {
    return 'No React dev server was detected in this project folder.';
  }
  return message;
}

export function DevServerControls({ projectId, onRunningChange }: DevServerControlsProps) {
  const [status, setStatus] = useState<DevServerStatusResponse | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchProjectDevServerStatus(projectId);
      setStatus(next);
      onRunningChange?.(next.status === 'running');
      if (next.status !== 'error') setError(null);
      else setError(next.lastError ?? 'Dev server failed.');
    } catch (err) {
      onRunningChange?.(false);
      setError(friendlyError(err instanceof Error ? err.message : 'Could not load dev server status.'));
    }
  }, [projectId, onRunningChange]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchProjectDevServerStatus(projectId);
        if (cancelled) return;
        setStatus(next);
        onRunningChange?.(next.status === 'running');
        setError(next.status === 'error' ? next.lastError ?? 'Dev server failed.' : null);
      } catch (err) {
        if (!cancelled) {
          onRunningChange?.(false);
          setError(friendlyError(err instanceof Error ? err.message : 'Could not load dev server status.'));
        }
      }
    };
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [projectId, onRunningChange]);

  const running = status?.status === 'running';
  const starting = status?.status === 'starting' || busyAction === 'start';
  const canOpen = running;
  const label = useMemo(() => statusLabel(status), [status]);

  const handleStart = useCallback(async () => {
    setBusyAction('start');
    setError(null);
    try {
      const started = await startProjectDevServer(projectId);
      setStatus({
        projectId,
        url: started.url,
        port: started.port,
        status: started.status,
        framework: started.framework,
        packageManager: started.packageManager,
        startedAt: Date.now(),
        uptimeMs: 0,
        lastError: null,
        pid: null,
      });
      onRunningChange?.(started.status === 'running');
      await refreshStatus();
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : 'Could not start dev server.'));
      await refreshStatus();
    } finally {
      setBusyAction(null);
    }
  }, [projectId, refreshStatus, onRunningChange]);

  const handleStop = useCallback(async () => {
    setBusyAction('stop');
    setError(null);
    try {
      await stopProjectDevServer(projectId);
      onRunningChange?.(false);
      await refreshStatus();
    } catch (err) {
      setError(friendlyError(err instanceof Error ? err.message : 'Could not stop dev server.'));
    } finally {
      setBusyAction(null);
    }
  }, [projectId, refreshStatus, onRunningChange]);

  const handleOpenPreview = useCallback(() => {
    window.open(projectDevServerProxyUrl(projectId), '_blank', 'noopener,noreferrer');
  }, [projectId]);

  return (
    <div className={styles.root} data-testid="dev-server-controls">
      <div className={styles.mainRow}>
        <span
          className={`${styles.statusDot} ${running ? styles.running : status?.status === 'error' ? styles.error : ''}`}
          aria-hidden
        />
        <span className={styles.label}>{label}</span>
        {running ? (
          <button type="button" className={styles.button} onClick={handleOpenPreview} disabled={!canOpen}>
            Open preview
          </button>
        ) : null}
        <button
          type="button"
          className={running ? styles.button : styles.primaryButton}
          onClick={running ? handleStop : handleStart}
          disabled={starting || busyAction === 'stop'}
        >
          {running ? (busyAction === 'stop' ? 'Stopping…' : 'Stop') : starting ? 'Starting…' : 'Start'}
        </button>
      </div>
      {error ? <div className={styles.errorText} role="status">{error}</div> : null}
    </div>
  );
}
