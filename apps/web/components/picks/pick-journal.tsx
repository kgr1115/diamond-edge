'use client';

import { useState, useCallback, useRef } from 'react';

const SUGGESTED_TAGS = [
  'fade-public',
  'weather-play',
  'revenge',
  'line-movement',
  'gut-call',
  'bullpen-fatigue',
  'travel-spot',
];

interface PickJournalProps {
  pickId: string;
  initialNote: string | null;
  initialTags: string[];
}

export function PickJournal({ pickId, initialNote, initialTags }: PickJournalProps) {
  const [note, setNote] = useState(initialNote ?? '');
  const [tags, setTags] = useState<string[]>(initialTags);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    async (nextNote: string, nextTags: string[]) => {
      setSaving(true);
      setSaveError(null);
      try {
        const res = await fetch(`/api/picks/${pickId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_note: nextNote, user_tags: nextTags }),
        });
        if (!res.ok) throw new Error('save failed');
        setSavedAt(new Date().toLocaleTimeString());
      } catch {
        setSaveError('Failed to save. Retrying on next change.');
      } finally {
        setSaving(false);
      }
    },
    [pickId]
  );

  function handleNoteBlur() {
    persist(note, tags);
  }

  function handleNoteChange(value: string) {
    setNote(value);
    // Debounce auto-save while typing (1.5s idle)
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => persist(value, tags), 1500);
  }

  function commitTagInput(raw: string) {
    const trimmed = raw.trim().toLowerCase().replace(/\s+/g, '-');
    if (!trimmed || tags.includes(trimmed)) {
      setTagInput('');
      return;
    }
    const next = [...tags, trimmed];
    setTags(next);
    setTagInput('');
    persist(note, next);
  }

  function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitTagInput(tagInput);
    }
    if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      const next = tags.slice(0, -1);
      setTags(next);
      persist(note, next);
    }
  }

  function removeTag(tag: string) {
    const next = tags.filter((t) => t !== tag);
    setTags(next);
    persist(note, next);
  }

  function addSuggestedTag(tag: string) {
    if (tags.includes(tag)) return;
    const next = [...tags, tag];
    setTags(next);
    persist(note, next);
  }

  return (
    <section
      className="bg-gray-900 border border-gray-800 rounded-lg p-5 space-y-4"
      aria-labelledby="journal-heading"
    >
      <div className="flex items-center justify-between">
        <h2
          id="journal-heading"
          className="text-sm font-semibold text-gray-400 uppercase tracking-wide"
        >
          Journal
        </h2>
        <span className="text-xs text-gray-600" aria-live="polite" aria-atomic="true">
          {saving && 'Saving…'}
          {!saving && saveError && (
            <span className="text-red-500">{saveError}</span>
          )}
          {!saving && !saveError && savedAt && `Saved ${savedAt}`}
        </span>
      </div>

      {/* Notes textarea */}
      <div>
        <label htmlFor="pick-note" className="text-xs text-gray-500 block mb-1">
          Notes
        </label>
        <textarea
          id="pick-note"
          value={note}
          onChange={(e) => handleNoteChange(e.target.value)}
          onBlur={handleNoteBlur}
          placeholder="Why did you take this pick? What do you want to remember?"
          rows={4}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-600 resize-y"
        />
      </div>

      {/* Tags */}
      <div>
        <label htmlFor="pick-tag-input" className="text-xs text-gray-500 block mb-1">
          Tags
          <span className="text-gray-700 ml-1 font-normal">(enter or comma to add)</span>
        </label>

        {/* Chip display + input */}
        <div
          className="min-h-[2.5rem] flex flex-wrap gap-1.5 items-center bg-gray-800 border border-gray-700 rounded px-2 py-1.5 focus-within:ring-1 focus-within:ring-blue-600 cursor-text"
          onClick={() => document.getElementById('pick-tag-input')?.focus()}
        >
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 bg-blue-900/60 text-blue-300 text-xs px-2 py-0.5 rounded-full"
            >
              {tag}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); removeTag(tag); }}
                className="text-blue-400 hover:text-white transition-colors leading-none"
                aria-label={`Remove tag ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
          <input
            id="pick-tag-input"
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleTagKeyDown}
            onBlur={() => { if (tagInput.trim()) commitTagInput(tagInput); }}
            placeholder={tags.length === 0 ? 'Add a tag…' : ''}
            className="bg-transparent text-sm text-white placeholder:text-gray-600 focus:outline-none min-w-[6rem] flex-1"
          />
        </div>

        {/* Suggested tags */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {SUGGESTED_TAGS.filter((t) => !tags.includes(t)).map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => addSuggestedTag(tag)}
              className="text-xs text-gray-500 border border-gray-700 hover:border-gray-500 hover:text-gray-300 px-2 py-0.5 rounded-full transition-colors"
            >
              + {tag}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
