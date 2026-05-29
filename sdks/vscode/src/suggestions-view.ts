/**
 * VS Code Suggestion Sidebar — Phase 3 starter scaffold.
 *
 * Status: SCAFFOLD ONLY. Builds the pane, wires the typing-debounce
 * listener, calls /api/recall/assist, renders cards in a webview.
 * NOT YET POLISHED — needs: per-workspace project hints, "accept"
 * inserts at cursor, keyboard shortcuts, settings UI.
 *
 * The plumbing IS production-quality. The tasteful UX is one more
 * focused day of work.
 */

import * as vscode from "vscode";

const HOSTED_BASE_URL =
  vscode.workspace.getConfiguration("mnueron").get<string>("hostedUrl") ??
  "https://mnueron.com";

const DEBOUNCE_MS = 2000;            // 2s typing pause before we trigger
const MIN_TEXT_LEN = 30;             // Don't bother below this
const CONTEXT_WINDOW_CHARS = 1200;   // How much surrounding text to send

export class MnueronSuggestionsProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "mnueron.suggestions";
  private view?: vscode.WebviewView;
  private debounceTimer?: NodeJS.Timeout;
  private lastQuery = "";

  constructor(private readonly context: vscode.ExtensionContext) {
    // Watch editor changes — fires on every keystroke. We debounce.
    vscode.workspace.onDidChangeTextDocument(
      (e) => this.onTextChange(e),
      null,
      context.subscriptions,
    );
    // Also when selection changes (user navigates to a different spot)
    vscode.window.onDidChangeTextEditorSelection(
      (e) => this.onSelectionChange(e),
      null,
      context.subscriptions,
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getInitialHtml();

    // Wire message handler: webview → extension
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "accept" || msg.type === "open" || msg.type === "ignore") {
        // Log outcome to mnueron
        await this.logOutcome(msg.outcomeId, msg.type === "ignore" ? "ignored" : msg.type === "accept" ? "accepted" : "opened", msg.actedOnId);
      }
      if (msg.type === "accept" && msg.content) {
        // Insert content at cursor
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          editor.edit((b) => b.insert(editor.selection.active, msg.content));
        }
      }
    });
  }

  private onTextChange(_e: vscode.TextDocumentChangeEvent): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.runAssist(), DEBOUNCE_MS);
  }

  private onSelectionChange(_e: vscode.TextEditorSelectionChangeEvent): void {
    // Trigger immediately when user moves cursor to a new spot
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.runAssist(), 500);
  }

  /** Extract the window of context around the current cursor. */
  private getActiveContext(): string {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return "";
    const doc = editor.document;
    const cursor = editor.selection.active;
    // Take CONTEXT_WINDOW_CHARS / 2 chars before + after cursor
    const offset = doc.offsetAt(cursor);
    const start = Math.max(0, offset - CONTEXT_WINDOW_CHARS / 2);
    const end = Math.min(doc.getText().length, offset + CONTEXT_WINDOW_CHARS / 2);
    return doc.getText().slice(start, end);
  }

  /** Project name guess from the workspace folder. */
  private getCwd(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.[0]?.uri.fsPath;
  }

  private async runAssist(): Promise<void> {
    if (!this.view) return;
    const text = this.getActiveContext().trim();
    if (text.length < MIN_TEXT_LEN || text === this.lastQuery) return;
    this.lastQuery = text;
    this.view.webview.postMessage({ type: "loading" });

    try {
      const apiToken = vscode.workspace.getConfiguration("mnueron").get<string>("apiToken");
      if (!apiToken) {
        this.view.webview.postMessage({
          type: "error",
          message: "Set 'mnueron.apiToken' in VS Code settings to enable suggestions.",
        });
        return;
      }
      // Threshold lets the user override the server's default 0.75 floor
      // without going through the Phase 5 tuning UI. Sent as `threshold` in
      // the body; recall-assist accepts it. Default is 0.5 (set in package.json
      // configuration block).
      const threshold = vscode.workspace
        .getConfiguration("mnueron")
        .get<number>("suggestionThreshold");
      const resp = await fetch(`${HOSTED_BASE_URL}/api/recall/assist`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          text,
          cwd: this.getCwd(),
          surface: "vscode",
          ...(typeof threshold === "number" ? { threshold } : {}),
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = await resp.json();
      this.view.webview.postMessage({ type: "suggestions", result: j });
    } catch (e) {
      this.view.webview.postMessage({
        type: "error",
        message: e instanceof Error ? e.message : "Couldn't fetch suggestions.",
      });
    }
  }

  private async logOutcome(outcomeId: string, action: string, actedOnId?: string): Promise<void> {
    const apiToken = vscode.workspace.getConfiguration("mnueron").get<string>("apiToken");
    if (!apiToken || !outcomeId) return;
    try {
      await fetch(`${HOSTED_BASE_URL}/api/recall/suggestion-outcome`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiToken}`,
        },
        body: JSON.stringify({ outcome_id: outcomeId, action, acted_on_id: actedOnId }),
      });
    } catch {
      // Logging is best-effort — don't surface telemetry errors to the user.
    }
  }

  private getInitialHtml(): string {
    return /* html */ `
<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; font-size: 12px; }
  h2 { font-size: 13px; margin: 0 0 8px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; margin-bottom: 8px; background: var(--vscode-editor-background); }
  .meta { color: var(--vscode-descriptionForeground); font-size: 10px; margin-bottom: 4px; }
  .content { font-size: 12px; line-height: 1.5; margin-bottom: 6px; }
  .actions { display: flex; gap: 4px; }
  button { font-size: 11px; padding: 3px 8px; border: 1px solid var(--vscode-button-border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; border-radius: 3px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .conf-high { color: var(--vscode-charts-green); }
  .conf-medium { color: var(--vscode-charts-orange); }
  .conf-low { color: var(--vscode-descriptionForeground); }
  .empty { padding: 20px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .loading { padding: 20px; text-align: center; color: var(--vscode-progressBar-background); font-size: 11px; }
</style></head>
<body>
  <h2>📚 mnueron suggestions</h2>
  <div id="root"><div class="empty">Start typing — suggestions will appear after a 2s pause.</div></div>
  <script>
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    let lastOutcomeId = null;

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'loading') {
        root.innerHTML = '<div class="loading">Searching mnueron…</div>';
      } else if (msg.type === 'error') {
        root.innerHTML = '<div class="empty" style="color: var(--vscode-errorForeground);">⚠ ' + msg.message + '</div>';
      } else if (msg.type === 'suggestions') {
        lastOutcomeId = msg.result.outcome_id;
        const { intent, suggestions, runbookDetection, entities } = msg.result;
        if (!suggestions || suggestions.length === 0) {
          root.innerHTML = '<div class="empty">No matches above 0.75 confidence for ' + intent.kind + '.</div>';
          return;
        }
        root.innerHTML = '<div class="meta">Intent: <b>' + intent.kind + '</b> · ' + (intent.confidence * 100).toFixed(0) + '%' +
          (entities.project ? ' · project:' + entities.project : '') + '</div>' +
          suggestions.map(renderCard).join('');
        // Bind actions
        document.querySelectorAll('[data-act]').forEach(btn => {
          btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-id');
            const act = btn.getAttribute('data-act');
            const content = btn.getAttribute('data-content');
            vscode.postMessage({ type: act, outcomeId: lastOutcomeId, actedOnId: id, content });
            btn.closest('.card').remove();
          });
        });
      }
    });

    function renderCard(s) {
      const confClass = s.confidence >= 0.85 ? 'conf-high' : s.confidence >= 0.7 ? 'conf-medium' : 'conf-low';
      return '<div class="card">' +
        '<div class="meta">' + s.kind + ' · <span class="' + confClass + '">' + (s.confidence * 100).toFixed(0) + '%</span>' + (s.namespace ? ' · ' + s.namespace : '') + '</div>' +
        '<div class="content">' + escapeHtml(s.content) + '</div>' +
        '<div class="actions">' +
          '<button class="primary" data-act="accept" data-id="' + s.id + '" data-content="' + escapeHtml(s.content) + '">Insert at cursor</button>' +
          '<button data-act="open" data-id="' + s.id + '">Open</button>' +
          '<button data-act="ignore" data-id="' + s.id + '">Dismiss</button>' +
        '</div></div>';
    }
    function escapeHtml(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  </script>
</body></html>`;
  }
}

/**
 * Activate this provider from extension.ts:
 *
 *   const provider = new MnueronSuggestionsProvider(context);
 *   context.subscriptions.push(
 *     vscode.window.registerWebviewViewProvider(
 *       MnueronSuggestionsProvider.viewType,
 *       provider,
 *     ),
 *   );
 *
 * And add to package.json contributes.views:
 *   "mnueron": [{ "type": "webview", "id": "mnueron.suggestions", "name": "Suggestions" }]
 */
