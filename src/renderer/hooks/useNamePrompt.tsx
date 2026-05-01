import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface PromptOptions {
  title: string;
  defaultValue?: string;
  okLabel?: string;
  placeholder?: string;
}

interface PromptState extends PromptOptions {
  value: string;
}

export type PromptName = (opts: PromptOptions) => Promise<string | null>;

export function useNamePrompt(): { prompt: PromptName; modal: React.ReactNode } {
  const [state, setState] = useState<PromptState | null>(null);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const prompt = useCallback<PromptName>((opts) => {
    return new Promise((resolve) => {
      if (resolverRef.current) {
        resolverRef.current(null);
      }
      resolverRef.current = resolve;
      setState({ ...opts, value: opts.defaultValue ?? '' });
    });
  }, []);

  const close = useCallback((value: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setState(null);
    resolve?.(value);
  }, []);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!state || !state.value.trim()) return;
    close(state.value);
  }, [state, close]);

  const inputRef = useCallback((node: HTMLInputElement | null) => {
    if (node) {
      node.focus();
      node.select();
    }
  }, []);

  const modal = state
    ? createPortal(
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => close(null)}
        >
          <div
            className="panel-shell w-[400px] p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[13px] font-semibold mb-3">{state.title}</h3>
            <form
              onSubmit={handleSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  close(null);
                }
              }}
              className="space-y-3"
            >
              <input
                ref={inputRef}
                type="text"
                value={state.value}
                onChange={(e) =>
                  setState((prev) => (prev ? { ...prev, value: e.target.value } : prev))
                }
                placeholder={state.placeholder}
                className="ui-input text-[13px]"
              />
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => close(null)}
                  className="ui-btn ui-btn-ghost px-3 py-1.5 text-[13px]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!state.value.trim()}
                  className="ui-btn ui-btn-primary px-3 py-1.5 text-[13px]"
                >
                  {state.okLabel ?? 'OK'}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body,
      )
    : null;

  return { prompt, modal };
}
