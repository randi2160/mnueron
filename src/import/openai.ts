/**
 * OpenAI / ChatGPT conversation export importer.
 *
 * Get the file: chatgpt.com → Settings → Data Controls → Export.
 * Email arrives with a ZIP containing `conversations.json`.
 *
 * Format is a TREE per conversation (parent/child message IDs), not a flat
 * list. We linearize by walking from the root through the current_node
 * pointer when present, otherwise by created_at.
 */
import { readFile } from 'node:fs/promises';
import type { SaveMemoryInput } from '../store/provider.js';

const MAX_CHARS = 8000;

interface OpenAIMessage {
  id?: string;
  author?: { role?: string; name?: string };
  content?: { content_type?: string; parts?: unknown[] };
  create_time?: number;
}

interface OpenAINode {
  id?: string;
  message?: OpenAIMessage | null;
  parent?: string | null;
  children?: string[];
}

interface OpenAIConversation {
  id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<string, OpenAINode>;
  current_node?: string;
}

export async function importOpenAIExport(
  path: string,
  namespace: string,
): Promise<SaveMemoryInput[]> {
  const raw = await readFile(path, 'utf8');
  const data = JSON.parse(raw);
  const conversations: OpenAIConversation[] = Array.isArray(data) ? data : (data.conversations ?? []);

  const memories: SaveMemoryInput[] = [];

  for (const conv of conversations) {
    const transcript = renderTranscript(conv);
    if (!transcript) continue;
    memories.push({
      content: transcript,
      namespace,
      source: 'openai-export',
      source_ref: conv.id,
      tags: ['imported', 'openai', 'chatgpt'],
      metadata: {
        title: conv.title,
        create_time: conv.create_time,
        update_time: conv.update_time,
      },
    });
  }

  return memories;
}

function renderTranscript(conv: OpenAIConversation): string {
  if (!conv.mapping) return '';
  const linear = linearize(conv);
  if (linear.length === 0) return '';

  const parts: string[] = [];
  if (conv.title) parts.push(`# ${conv.title}`);
  if (conv.create_time) {
    parts.push(`(${new Date(conv.create_time * 1000).toISOString()})`);
  }
  parts.push('');

  for (const msg of linear) {
    const role = msg.author?.role;
    if (role === 'system' || role === 'tool') continue;
    const who = role === 'assistant' ? 'ChatGPT' : 'User';
    const text = extractText(msg);
    if (!text.trim()) continue;
    parts.push(`**${who}:** ${text}`);
    parts.push('');
  }

  let out = parts.join('\n').trim();
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS) + `\n\n[truncated — original ${out.length} chars]`;
  }
  return out;
}

function linearize(conv: OpenAIConversation): OpenAIMessage[] {
  // Prefer current_node path (the active branch). Walk parent pointers up
  // to the root, then reverse.
  const mapping = conv.mapping!;
  const result: OpenAIMessage[] = [];
  let cursor: string | null | undefined = conv.current_node;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node: OpenAINode | undefined = mapping[cursor];
    if (!node) break;
    if (node.message) result.push(node.message);
    cursor = node.parent ?? null;
  }
  result.reverse();

  if (result.length === 0) {
    // Fallback: sort all messages by create_time
    return Object.values(mapping)
      .map(n => n.message)
      .filter((m): m is OpenAIMessage => !!m)
      .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  }
  return result;
}

function extractText(msg: OpenAIMessage): string {
  const parts = msg.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map(p => (typeof p === 'string' ? p : ''))
    .filter(Boolean)
    .join('\n');
}
