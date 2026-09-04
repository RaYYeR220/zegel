'use client';

import type { ReactNode } from 'react';

export interface LogLine {
  text: string;
  bad: boolean;
}

/**
 * The machine, working.
 *
 * Open while it runs, because the interesting part of a thirty-second collection
 * is which endpoint answered and what it cost — a spinner over that is a lie of
 * omission. Folded away afterwards, because the document is what the reader came
 * for, and the tape is still there for anyone who wants to check it.
 */
export function ProgressLog({
  lines,
  running,
  progress,
}: {
  lines: readonly LogLine[];
  running: boolean;
  progress: { done: number; total: number } | null;
}): ReactNode {
  if (lines.length === 0) return null;

  const failures = lines.filter((line) => line.bad).length;

  if (running) {
    return (
      <>
        {progress !== null && (
          <div className="progressbar" aria-hidden="true">
            <i style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
        )}
        <div className="progresslog" role="log" aria-live="polite">
          {lines.map((line, index) => (
            <div key={`${index}-${line.text}`} className={line.bad ? 'bad' : ''}>
              {line.text}
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <details className="tape">
      <summary>
        {lines.length} regels van de leesband
        <span> / {lines.length} lines of tape</span>
        {failures > 0 && <b> — {failures} upstream(s) did not answer</b>}
      </summary>
      <div className="progresslog">
        {lines.map((line, index) => (
          <div key={`${index}-${line.text}`} className={line.bad ? 'bad' : ''}>
            {line.text}
          </div>
        ))}
      </div>
    </details>
  );
}
