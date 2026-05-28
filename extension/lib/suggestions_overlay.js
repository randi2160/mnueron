/**
 * mnueron Chrome extension — live suggestions overlay
 *
 * Phase 4 starter scaffold. When the user types in a textarea or
 * contenteditable on a supported site (claude.ai, chatgpt.com), this
 * script:
 *   1. Watches the focused field for typing pauses (1.5s debounce)
 *   2. When the text accumulates > 30 chars, POSTs to mnueron.com/api/recall/assist
 *   3. Renders a floating card next to the textarea with up to 3 suggestions
 *   4. On click: "Add to prompt" inserts at cursor, "Open" opens the
 *      memory in a new tab on mnueron.com, "Dismiss" hides the card
 *
 * Status: SCAFFOLD. Working pipeline + UI. Needs: per-site adapters,
 * settings UI for enabling/disabling, multi-language support, accept
 * actions that work in claude.ai vs chatgpt.com vs gemini etc.
 *
 * Wired up by adding to manifest.json content_scripts after the
 * existing capture scripts:
 *   "matches": ["https://claude.ai/*", "https://chatgpt.com/*"],
 *   "js": ["lib/suggestions_overlay.js"]
 */
(function () {
  "use strict";

  const HOSTED_BASE = "https://mnueron.com";
  const DEBOUNCE_MS = 1500;
  const MIN_TEXT_LEN = 30;
  const CARD_ID = "mnueron-suggestions-card";

  let debounceTimer = null;
  let lastQuery = "";
  let currentOutcomeId = null;

  // ─── Watch focused inputs for typing ─────────────────────────────────
  document.addEventListener(
    "input",
    (e) => {
      const t = e.target;
      if (!isInputLike(t)) return;
      const text = getInputText(t);
      if (text.length < MIN_TEXT_LEN || text === lastQuery) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => triggerAssist(t, text), DEBOUNCE_MS);
    },
    true,
  );

  // ─── Trigger assist + render card ────────────────────────────────────
  async function triggerAssist(target, text) {
    lastQuery = text;
    showCard(target, { state: "loading" });

    try {
      const { apiToken } = await chrome.storage.local.get("apiToken");
      if (!apiToken) {
        showCard(target, {
          state: "error",
          message:
            "Add your mnueron API token in the extension options to enable live suggestions.",
        });
        return;
      }
      const r = await fetch(`${HOSTED_BASE}/api/recall/assist`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          text,
          surface: "chrome",
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      currentOutcomeId = j.outcome_id;
      if (!j.suggestions || j.suggestions.length === 0) {
        hideCard();
        return;
      }
      showCard(target, { state: "suggestions", result: j });
    } catch (e) {
      showCard(target, {
        state: "error",
        message: e.message ?? "Couldn't load suggestions.",
      });
    }
  }

  // ─── Card UI ─────────────────────────────────────────────────────────
  function showCard(target, payload) {
    let card = document.getElementById(CARD_ID);
    if (!card) {
      card = document.createElement("div");
      card.id = CARD_ID;
      Object.assign(card.style, {
        position: "fixed",
        zIndex: "2147483647",
        background: "white",
        border: "1px solid #e2e8f0",
        boxShadow: "0 6px 24px rgba(15,23,42,0.12)",
        borderRadius: "12px",
        padding: "12px",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        fontSize: "13px",
        color: "#1e293b",
        width: "360px",
        maxHeight: "60vh",
        overflowY: "auto",
      });
      document.body.appendChild(card);
    }
    positionCard(card, target);
    card.innerHTML = renderCard(payload);
    bindCardActions(card, target);
  }

  function hideCard() {
    const card = document.getElementById(CARD_ID);
    if (card) card.remove();
  }

  function renderCard(payload) {
    if (payload.state === "loading") {
      return `<div style="display:flex;align-items:center;gap:8px;color:#6366f1;">
        <span style="display:inline-block;width:14px;height:14px;border:2px solid #c7d2fe;border-top-color:#6366f1;border-radius:50%;animation:mnueron-spin 0.8s linear infinite;"></span>
        Searching mnueron…
      </div>
      <style>@keyframes mnueron-spin{to{transform:rotate(360deg)}}</style>`;
    }
    if (payload.state === "error") {
      return `<div style="color:#dc2626;font-size:12px;">⚠ ${escapeHtml(payload.message)}</div>`;
    }
    const { intent, suggestions, entities } = payload.result;
    let html = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-size:11px;color:#64748b;">
      <span><strong style="color:#1e293b;">📚 mnueron</strong> · ${intent.kind} ${(intent.confidence * 100).toFixed(0)}%</span>
      <button id="mnueron-close" style="background:none;border:0;cursor:pointer;color:#94a3b8;font-size:14px;">×</button>
    </div>`;
    for (const s of suggestions) {
      const confColor = s.confidence >= 0.85 ? "#059669" : s.confidence >= 0.7 ? "#d97706" : "#64748b";
      const kindIcon = s.kind === "runbook" ? "✨" : "📌";
      html += `<div data-suggestion-id="${escapeHtml(s.id)}" style="border:1px solid #e2e8f0;border-radius:8px;padding:8px;margin-bottom:8px;">
        <div style="font-size:10px;color:#64748b;margin-bottom:4px;">
          ${kindIcon} ${s.kind} · <span style="color:${confColor};font-weight:600;">${(s.confidence * 100).toFixed(0)}%</span>
          ${s.namespace ? ` · ${escapeHtml(s.namespace)}` : ""}
        </div>
        <div style="font-size:12px;line-height:1.5;color:#334155;margin-bottom:6px;max-height:80px;overflow:hidden;">
          ${escapeHtml(s.content.slice(0, 200))}${s.content.length > 200 ? "…" : ""}
        </div>
        <div style="display:flex;gap:4px;">
          <button data-act="add" data-content="${escapeHtml(s.content)}" style="padding:3px 8px;font-size:11px;background:#7c3aed;color:white;border:0;border-radius:4px;cursor:pointer;">Add to prompt</button>
          <button data-act="open" style="padding:3px 8px;font-size:11px;background:white;color:#1e293b;border:1px solid #e2e8f0;border-radius:4px;cursor:pointer;">Open</button>
          <button data-act="ignore" style="padding:3px 8px;font-size:11px;background:none;color:#94a3b8;border:0;cursor:pointer;margin-left:auto;">Dismiss</button>
        </div>
      </div>`;
    }
    return html;
  }

  function bindCardActions(card, target) {
    const close = card.querySelector("#mnueron-close");
    if (close) close.addEventListener("click", () => hideCard());

    card.querySelectorAll("[data-suggestion-id]").forEach((node) => {
      const sid = node.getAttribute("data-suggestion-id");
      node.querySelectorAll("[data-act]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const act = btn.getAttribute("data-act");
          if (act === "add") {
            insertAtCursor(target, btn.getAttribute("data-content"));
            await logOutcome("accepted", sid);
            node.remove();
          } else if (act === "open") {
            window.open(`${HOSTED_BASE}/dashboard?memory=${sid}`, "_blank");
            await logOutcome("opened", sid);
            node.remove();
          } else if (act === "ignore") {
            await logOutcome("ignored", sid);
            node.remove();
          }
          if (card.querySelectorAll("[data-suggestion-id]").length === 0) hideCard();
        });
      });
    });
  }

  async function logOutcome(action, sid) {
    if (!currentOutcomeId) return;
    try {
      const { apiToken } = await chrome.storage.local.get("apiToken");
      if (!apiToken) return;
      await fetch(`${HOSTED_BASE}/api/recall/suggestion-outcome`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          outcome_id: currentOutcomeId,
          action,
          acted_on_id: sid,
        }),
      });
    } catch {
      // Best-effort
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────
  function isInputLike(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT" && (el.type === "text" || el.type === "search")) return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function getInputText(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    if (el.isContentEditable) return el.innerText || "";
    return "";
  }

  function insertAtCursor(el, text) {
    if (!text) return;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      el.value = el.value.slice(0, start) + text + "\n" + el.value.slice(end);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.selectionStart = el.selectionEnd = start + text.length + 1;
    } else if (el.isContentEditable) {
      el.focus();
      document.execCommand("insertText", false, text + "\n");
    }
  }

  function positionCard(card, target) {
    const rect = target.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    let top = rect.bottom + 8;
    let left = rect.left;
    // If card would overflow viewport bottom, put it above the input.
    if (top + cardRect.height > window.innerHeight - 16) {
      top = Math.max(16, rect.top - cardRect.height - 8);
    }
    // Keep within viewport horizontally
    if (left + 380 > window.innerWidth) left = window.innerWidth - 380 - 16;
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
