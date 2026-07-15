'use client';

import { useState, useEffect, useRef } from 'react';
import { api } from '@/lib/api';
import type { ChatMessage, ChatMessagesResponse, ChatMessageResponse, RegenerateSummaryResponse } from '@/lib/types';
import { RoleGate } from '@/components/shared/RoleGate';

interface SummaryChatProps {
  bookingId: string;
  initialSummary: string;
  isDoctor: boolean;
  initialLlmStatus: string;
  doctorNotes?: string;
}

export function SummaryChat({
  bookingId,
  initialSummary,
  isDoctor,
  initialLlmStatus,
  doctorNotes,
}: SummaryChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [llmStatus, setLlmStatus] = useState(initialLlmStatus);
  const [remainingQuestions, setRemainingQuestions] = useState(5);
  const [maxQuestions, setMaxQuestions] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Load chat history on mount
  useEffect(() => {
    let mounted = true;
    api.getChatMessages(bookingId)
      .then((data) => {
        if (!mounted) return;
        setMessages(data.messages);
        setRemainingQuestions(data.remainingQuestions);
        setMaxQuestions(data.maxQuestions);
      })
      .catch((err) => {
        if (mounted) console.error('Failed to load chat:', err);
      });
    return () => { mounted = false; };
  }, [bookingId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || sending) return;

    const question = input.trim();
    setInput('');
    setSending(true);
    setError(null);

    // Optimistic user message
    const optimisticMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: question,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const res = await api.postChatMessage(bookingId, { question });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimisticMsg.id
            ? { ...m, role: 'assistant' as const, content: res.answer, id: `temp-${Date.now()}-assistant` }
            : m
        )
      );
      setRemainingQuestions(res.remainingQuestions);
      setLlmStatus(res.status);
    } catch (err: unknown) {
      const apiErr = err as { code?: string; message?: string; status?: number };
      if (apiErr.code === 'CAP_REACHED') {
        setError(apiErr.message ?? 'Follow-up limit reached');
      } else if (apiErr.code === 'SUMMARY_NOT_READY') {
        setError(apiErr.message ?? 'Summary not ready yet');
      } else {
        setError('Failed to send question. Please try again.');
      }
      // Remove optimistic message on error
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id));
    } finally {
      setSending(false);
    }
  };

  const handleRegenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    setError(null);
    setInfo(null);

    try {
      const res = await api.regenerateSummary(bookingId);
      setInfo(res.message ?? 'Summary regeneration queued. Chat history cleared.');
      setLlmStatus(res.llmStatus);
      setMessages([]);
      setRemainingQuestions(res.maxQuestions ?? 5);
      // Optionally: poll or reload summary status when regenerated
    } catch (err: unknown) {
      const apiErr = err as { code?: string; message?: string };
      setError(apiErr.message ?? 'Failed to regenerate summary');
    } finally {
      setRegenerating(false);
    }
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const isLoading = llmStatus === 'PENDING' || llmStatus === 'RETRYING';

  return (
    <div className="space-y-4 p-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
      {/* Summary header */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Post-Visit Summary
          </h3>
          <div className="flex items-center gap-2">
            <span
              className={`px-2 py-0.5 text-xs rounded-full ${
                llmStatus === 'GENERATED' ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' :
                llmStatus === 'FALLBACK' ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200' :
                'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200'
              }`}
            >
              {llmStatus}
            </span>
            {isDoctor && (
              <button
                onClick={handleRegenerate}
                disabled={regenerating || isLoading}
                className="px-3 py-1 text-sm text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded"
              >
                {regenerating ? 'Regenerating…' : 'Regenerate Summary'}
              </button>
            )}
          </div>
        </div>

        {doctorNotes && isDoctor && (
          <details className="group">
            <summary className="text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none">
              Show Doctor's Clinical Notes
            </summary>
            <pre className="mt-2 p-3 text-sm bg-gray-50 dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-700 whitespace-pre-wrap overflow-auto max-h-48">
              {doctorNotes}
            </pre>
          </details>
        )}

        <div className="prose prose-sm max-w-none bg-gray-50 dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-700 whitespace-pre-wrap">
          {initialSummary || (isLoading ? 'Generating summary…' : 'Summary not yet available.')}
        </div>
      </div>

      {/* Follow-up Q&A */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium text-gray-900 dark:text-white">Follow-up Questions</h4>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {remainingQuestions} / {maxQuestions} remaining
          </span>
        </div>

        {error && (
          <div className="mb-3 p-3 text-sm text-red-600 bg-red-50 dark:bg-red-900/30 rounded border border-red-200 dark:border-red-800">
            {error}
          </div>
        )}
        {info && (
          <div className="mb-3 p-3 text-sm text-blue-600 bg-blue-50 dark:bg-blue-900/30 rounded border border-blue-200 dark:border-blue-800">
            {info}
          </div>
        )}

        {/* Message list */}
        <div className="space-y-3 max-h-96 overflow-y-auto pr-2 mb-4">
          {messages.length === 0 && !sending ? (
            <p className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">
              No follow-up questions yet. Ask anything about your visit summary below.
            </p>
          ) : (
            messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] px-4 py-2 rounded-2xl text-sm ${
                    msg.role === 'user'
                      ? 'bg-blue-600 text-white rounded-br-none'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white rounded-bl-none'
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  <p className={`text-[10px] mt-1 opacity-70 ${msg.role === 'user' ? 'text-right' : ''}`}>
                    {formatTime(msg.createdAt)}
                  </p>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input form */}
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={remainingQuestions > 0 ? 'Ask a follow-up question…' : 'Follow-up limit reached'}
            disabled={sending || remainingQuestions <= 0 || isLoading}
            className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            maxLength={500}
          />
          <button
            type="submit"
            disabled={sending || !input.trim() || remainingQuestions <= 0 || isLoading}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? 'Sending…' : 'Ask'}
          </button>
        </form>

        {remainingQuestions <= 0 && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
            You've reached the maximum of {maxQuestions} follow-up questions for this visit.
          </p>
        )}
      </div>
    </div>
  );
}