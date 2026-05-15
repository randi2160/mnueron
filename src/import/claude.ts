/**
 * Claude conversation export importer.
 *
 * Get the file: claude.ai → Settings → Privacy → Export data.
 * You receive an email with a download link; the ZIP contains
 * `conversations.json` and (often) `users.json` + `projects.json`.
 *
 * Format (one entry per conversation):
 *   {
 *     "uuid": "...",
 *     "name": "Conversation title",
 *     "created_at": "2025-...",
 *     "updated_at": "2025-...",
 *     "chat_messages": [
 *       { "uuid", "text", "sender": "human" | "assistant", "created_at", ... }
 *     ]
 *   }
 *
 * Each conversation becomes ONE memory containing a flattened transcript.
 * For very long chats we truncate at MAX_CHARS — you can re-run with
 * `summarize: true` later (requires a summarizer service).
 */
import { readFile } from 'node:fs/promises';
import type { SaveMemoryInput } from '../store/provider.js';

const MAX_CHARS = 8000; // ~2K tokens. Tune for your use case.

interface ClaudeMessage {
  uuid?: string;
  text?: string;
  sender?: 'human' | 'assistant';
  created_at?: string;
  // Newer exports use `content: [{type, text}]` arrays. We handle both.
  content?: Array<{ type?: string; text?: string }>;
}

interface ClaudeConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeMessage[];
}

export async function importClaudeExport(
  path: string,
  namespace: string,
): Promise<SaveMemoryInput[]> {
  const raw = await readFile(path, 'utf8');
  const data = JSON.parse(raw);
  const conversations: ClaudeConversation[] = Array.isArray(data) ? data : (data.conversations ?? []);

  const memories: SaveMemoryInput[] = [];

  for (const conv of conversations) {
    const transcript = renderTranscript(conv);
    if (!transcript) continue;
    memories.push({
      content: transcript,
      namespace,
      source: 'claude-export',
      source_ref: conv.uuid,
      tags: ['imported', 'claude'],
      metadata: {
        title: conv.name,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        message_count: conv.chat_messages?.length ?? 0,
      },
    });
  }

  return memories;
}

function renderTranscript(conv: ClaudeConversation): string {
  const parts: string[] = [];
  if (conv.name) parts.push(`# ${conv.name}`);
  if (conv.created_at) parts.push(`(${conv.created_at})`);
  parts.push('');

  for (const msg of conv.chat_messages ?? []) {
    const who = msg.sender === 'assistant' ? 'Claude' : 'User';
    const text = extractText(msg);
    if (!text) continue;
    parts.push(`**${who}:** ${text}`);
    parts.push('');
  }

  let out = parts.join('\n').trim();
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS) + `\n\n[truncated — original ${out.length} chars]`;
  }
  return out;
}

function extractText(msg: ClaudeMessage): string {
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text)
      .join('\n');
  }
  return '';
}
