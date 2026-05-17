/**
 * mnueron VS Code extension — entry point.
 *
 * Wires four user-facing surfaces:
 *
 *   1. Sidebar memory list ("mnueron" view container in the activity bar).
 *      Shows recent memories in the active namespace. Click to peek.
 *
 *   2. Command "Save selection as memory" (Cmd/Ctrl+Shift+M).
 *      Saves the current editor selection with file path + language as
 *      metadata. If nothing's selected, prompts for content via input box.
 *
 *   3. Command "Recall memory…" (Cmd/Ctrl+Shift+R).
 *      QuickPick over search results. Picking an item inserts its content
 *      at the cursor (in editor) or copies to clipboard (no editor).
 *
 *   4. Status bar item.
 *      Shows the current namespace + memory count. Click to switch
 *      namespace. With `mnueron.ambientContext` enabled, also shows
 *      "N related" for the file you have open.
 *
 * Talks to either the local CLI (no auth) or the hosted backend (bearer
 * token). Toggle via the `mnueron.mode` setting.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';

import { MnueronClient, Memory } from './client.js';

let client: MnueronClient;
let statusBar: vscode.StatusBarItem;
let memoryProvider: MemoryTreeProvider;

export function activate(context: vscode.ExtensionContext) {
  client = makeClient();

  memoryProvider = new MemoryTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mnueronMemories', memoryProvider),
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'mnueron.switchNamespace';
  context.subscriptions.push(statusBar);
  refreshStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand('mnueron.saveSelection', cmdSaveSelection),
    vscode.commands.registerCommand('mnueron.recall', cmdRecall),
    vscode.commands.registerCommand('mnueron.openMemory', cmdOpenMemory),
    vscode.commands.registerCommand('mnueron.refreshSidebar', () => memoryProvider.refresh()),
    vscode.commands.registerCommand('mnueron.switchNamespace', cmdSwitchNamespace),
    vscode.commands.registerCommand('mnueron.openDashboard', cmdOpenDashboard),
  );

  // Re-init client whenever settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mnueron')) {
        client = makeClient();
        memoryProvider.refresh();
        refreshStatusBar();
      }
    }),
  );

  // Ambient context: re-check on editor change if enabled
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async () => {
      if (settings().ambientContext) await updateAmbientCount();
    }),
  );

  // First paint
  void memoryProvider.refresh();
  if (settings().ambientContext) void updateAmbientCount();
}

export function deactivate() {
  // Nothing to clean up — no long-lived sockets or watchers.
}

// ── Commands ─────────────────────────────────────────────────────────────

async function cmdSaveSelection() {
  const editor = vscode.window.activeTextEditor;
  let content: string | undefined;
  let lang: string | undefined;
  let filePath: string | undefined;

  if (editor && !editor.selection.isEmpty) {
    content = editor.document.getText(editor.selection);
    lang = editor.document.languageId;
    filePath = vscode.workspace.asRelativePath(editor.document.uri);
  } else {
    // Prompt
    content = await vscode.window.showInputBox({
      prompt: 'Memory content',
      placeHolder: 'e.g. "We decided to use bcrypt for password hashing"',
    });
    if (!content) return;
  }

  const cfg = settings();
  try {
    const saved = await client.save({
      content,
      namespace: cfg.activeNamespace,
      source: 'vscode',
      tags: lang ? [lang] : [],
      metadata: filePath ? { file: filePath, language: lang } : undefined,
    });
    void vscode.window.showInformationMessage(
      `Saved to "${saved.namespace}" (${saved.id.slice(0, 8)})`,
      'Show in sidebar',
    ).then((pick) => {
      if (pick) {
        void vscode.commands.executeCommand('workbench.view.extension.mnueron');
        memoryProvider.refresh();
      }
    });
    memoryProvider.refresh();
    refreshStatusBar();
  } catch (e) {
    void vscode.window.showErrorMessage(`mnueron: save failed — ${(e as Error).message}`);
  }
}

async function cmdRecall() {
  const cfg = settings();
  const query = await vscode.window.showInputBox({
    prompt: 'Recall memories matching…',
    placeHolder: 'e.g. "auth approach" or "rate limiting"',
  });
  if (!query) return;

  const pick = vscode.window.createQuickPick<MemoryPickItem>();
  pick.placeholder = `Searching mnueron (${cfg.activeNamespace})…`;
  pick.busy = true;
  pick.show();
  try {
    const hits = await client.search(query, { namespace: cfg.activeNamespace, k: 15 });
    pick.busy = false;
    pick.items = hits.map((m) => ({
      label: truncate(m.content.replace(/\s+/g, ' '), 80),
      description: m.tags?.join(', '),
      detail: `${m.namespace} • ${m.id.slice(0, 8)} • ${
        m.created_at ? new Date(m.created_at).toLocaleDateString() : ''
      }`,
      memory: m,
    }));
    if (hits.length === 0) pick.placeholder = 'No matches.';
  } catch (e) {
    pick.busy = false;
    void vscode.window.showErrorMessage(`mnueron: search failed — ${(e as Error).message}`);
    pick.dispose();
    return;
  }
  pick.onDidAccept(() => {
    const selected = pick.selectedItems[0];
    pick.hide();
    if (!selected) return;
    insertOrCopy(selected.memory);
  });
  pick.onDidHide(() => pick.dispose());
}

function insertOrCopy(mem: Memory) {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    void editor.edit((edit) => {
      edit.insert(editor.selection.active, mem.content);
    });
  } else {
    void vscode.env.clipboard.writeText(mem.content);
    void vscode.window.showInformationMessage('mnueron: memory copied to clipboard');
  }
}

async function cmdOpenMemory() {
  const id = await vscode.window.showInputBox({
    prompt: 'Memory id (full or first 8 chars)',
  });
  if (!id) return;
  try {
    const mem = await client.get(id);
    if (!mem) {
      void vscode.window.showWarningMessage('mnueron: memory not found');
      return;
    }
    const doc = await vscode.workspace.openTextDocument({
      content: mem.content,
      language: detectLanguage(mem),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch (e) {
    void vscode.window.showErrorMessage(`mnueron: open failed — ${(e as Error).message}`);
  }
}

async function cmdSwitchNamespace() {
  try {
    const namespaces = await client.namespaces();
    const items: vscode.QuickPickItem[] = namespaces.map((n) => ({
      label: n.name,
      description: `${n.count} memories`,
      detail: n.last_updated
        ? `last updated ${new Date(n.last_updated).toLocaleDateString()}`
        : undefined,
    }));
    items.push({ label: '$(plus) New namespace…' });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Switch active namespace',
    });
    if (!pick) return;
    let chosen = pick.label;
    if (chosen.startsWith('$(plus)')) {
      const fresh = await vscode.window.showInputBox({ prompt: 'New namespace name' });
      if (!fresh) return;
      chosen = fresh;
    }
    await vscode.workspace
      .getConfiguration('mnueron')
      .update('activeNamespace', chosen, vscode.ConfigurationTarget.Global);
    refreshStatusBar();
    memoryProvider.refresh();
  } catch (e) {
    void vscode.window.showErrorMessage(`mnueron: namespaces failed — ${(e as Error).message}`);
  }
}

function cmdOpenDashboard() {
  const cfg = settings();
  const url = cfg.mode === 'hosted' ? cfg.hostedUrl + '/dashboard' : cfg.localUrl;
  void vscode.env.openExternal(vscode.Uri.parse(url));
}

// ── Sidebar tree provider ─────────────────────────────────────────────────

interface MemoryPickItem extends vscode.QuickPickItem {
  memory: Memory;
}

class MemoryTreeProvider implements vscode.TreeDataProvider<MemoryNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MemoryNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private cache: Memory[] = [];

  refresh() {
    this._onDidChangeTreeData.fire();
    void this.reload();
  }

  private async reload() {
    try {
      this.cache = await client.list({ namespace: settings().activeNamespace, limit: 25 });
      this._onDidChangeTreeData.fire();
    } catch {
      // Tree shows an error placeholder via getChildren
      this.cache = [];
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(el: MemoryNode): vscode.TreeItem {
    const item = new vscode.TreeItem(el.label, vscode.TreeItemCollapsibleState.None);
    item.tooltip = el.tooltip;
    item.description = el.description;
    item.iconPath = new vscode.ThemeIcon('note');
    if (el.memory) {
      item.command = {
        command: 'mnueron.openMemory',
        title: 'Open memory',
        arguments: [el.memory.id],
      };
      item.contextValue = 'memory';
    }
    return item;
  }

  async getChildren(): Promise<MemoryNode[]> {
    if (this.cache.length === 0) {
      return [
        {
          label: 'No memories in this namespace yet.',
          tooltip: 'Save a memory with Cmd/Ctrl+Shift+M, or switch namespace.',
        },
      ];
    }
    return this.cache.map((m) => ({
      label: truncate(m.content.replace(/\s+/g, ' '), 60),
      description: m.tags?.join(', '),
      tooltip: m.content,
      memory: m,
    }));
  }
}

interface MemoryNode {
  label: string;
  description?: string;
  tooltip?: string;
  memory?: Memory;
}

// ── Status bar + ambient context ──────────────────────────────────────────

function refreshStatusBar() {
  const cfg = settings();
  statusBar.text = `$(database) mnueron · ${cfg.activeNamespace}`;
  statusBar.tooltip = `mnueron — ${cfg.mode} mode (${
    cfg.mode === 'hosted' ? cfg.hostedUrl : cfg.localUrl
  })\nClick to switch namespace`;
  statusBar.show();
}

async function updateAmbientCount() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const cfg = settings();
  const fname = path.basename(editor.document.fileName);
  try {
    const hits = await client.search(fname, { namespace: cfg.activeNamespace, k: 3 });
    const n = hits.length;
    if (n > 0) {
      statusBar.text = `$(database) mnueron · ${cfg.activeNamespace} · ${n} related`;
    } else {
      refreshStatusBar();
    }
  } catch {
    // Silent — ambient is opt-in and best-effort
  }
}

// ── Settings + client wiring ──────────────────────────────────────────────

interface Settings {
  mode: 'local' | 'hosted';
  hostedUrl: string;
  localUrl: string;
  apiToken: string;
  activeNamespace: string;
  ambientContext: boolean;
}

function settings(): Settings {
  const c = vscode.workspace.getConfiguration('mnueron');
  return {
    mode: c.get<'local' | 'hosted'>('mode', 'local'),
    hostedUrl: c.get<string>('hostedUrl', 'https://www.mnueron.com'),
    localUrl: c.get<string>('localUrl', 'http://127.0.0.1:3122'),
    apiToken: c.get<string>('apiToken', ''),
    activeNamespace: c.get<string>('activeNamespace', 'vscode'),
    ambientContext: c.get<boolean>('ambientContext', false),
  };
}

function makeClient(): MnueronClient {
  const cfg = settings();
  if (cfg.mode === 'hosted') {
    return new MnueronClient({ baseUrl: cfg.hostedUrl, token: cfg.apiToken });
  }
  return new MnueronClient({ baseUrl: cfg.localUrl });
}

// ── helpers ───────────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function detectLanguage(m: Memory): string {
  // Best-effort: if a `language` metadata key exists, use it. Otherwise
  // VS Code will pick from the content.
  const meta = (m.metadata ?? {}) as Record<string, unknown>;
  if (typeof meta.language === 'string') return meta.language;
  return 'markdown';
}
