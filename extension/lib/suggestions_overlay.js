/**
 * mnueron Chrome extension — live suggestions overlay
 *
 * Watches the focused textarea/contenteditable on claude.ai, chatgpt.com,
 * and gemini.google.com. After a 1.5s typing pause with 30+ chars, asks
 * background.js to call /api/recall/assist (bounced through the service
 * worker so the fetch uses the extension's origin and bypasses CORS).
 * Renders a floating card with up to 3 suggestion matches.
 *
 * Diagnostic logging on by default — prefix `[mnueron/suggest]`. Set
 * MNUERON_OVERLAY_QUIET = true to silence once it's confirmed wired.
 */
(function () {
  "use strict";

  const DEFAULT_HOSTED_BASE = "https://mnueron.com";
  const DEBOUNCE_MS = 1500;
  const MIN_TEXT_LEN = 30;
  const CARD_ID = "mnueron-suggestions-card";
  const SEND_TIMEOUT_MS = 10000;  // Stuck-spinner safety net

  // Toggleable via window.MNUERON_OVERLAY_QUIET = true in DevTools console
  const log = (...args) => {
    if (!window.MNUERON_OVERLAY_QUIET) console.log("[mnueron/suggest]", ...args);
  };

  log("overlay loaded on", location.host);

  let debounceTimer = null;
  let lastQuery = "";
  let currentOutcomeId = null;

  async function getHostedConfig() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "mnueron:get_settings" });
      const s = res?.settings || {};
      if (!s.prefer_hosted) return null;
      if (!s.hosted_token) return null;
      return {
        baseUrl: (s.hosted_url || DEFAULT_HOSTED_BASE).replace(/\/$/, ""),
        token: s.hosted_token,
      };
    } catch (e) {
      log("getHostedConfig failed:", e?.message);
      return null;
    }
  }

  /**
   * Timeout-wrapped sendMessage. Prevents the spinner from hanging forever
   * when the MV3 service worker is killed mid-fetch.
   */
  function sendMessageWithTimeout(payload, ms = SEND_TIMEOUT_MS) {
    return Promise.race([
      chrome.runtime.sendMessage(payload),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout after ${ms}ms — background.js didn't respond`)), ms),
      ),
    ]);
  }

  document.addEventListener(
    "input",
    (e) => {
      const t = e.target;
      const inputLike = isInputLike(t);
      if (!inputLike) {
        // Sample log so we can see what claude.ai/chatgpt.com fire input
        // events from. Throttled via lastQuery to avoid log spam.
        if (lastQuery !== "__not_input_like__") {
          log("input event ignored — not input-like:", t?.tagName, "ce:", t?.isContentEditable);
          lastQuery = "__not_input_like__";
        }
        return;
      }
      const text = getInputText(t);
      if (text.length < MIN_TEXT_LEN || text === lastQuery) return;
      log("input from", t.tagName, "len:", text.length, "— debouncing");
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => triggerAssist(t, text), DEBOUNCE_MS);
    },
    true,
  );

  async function triggerAssist(target, text) {
    lastQuery = text;
    log("triggerAssist firing, text.length:", text.length);
    const cfg = await getHostedConfig();
    if (!cfg) {
      const res = await chrome.runtime.sendMessage({ type: "mnueron:get_settings" }).catch(() => null);
      const s = res?.settings || {};
      if (s.prefer_hosted && !s.hosted_token) {
        log("showing onboarding card");
        showCard(target, {
          state: "onboarding",
          hostedUrl: (s.hosted_url || DEFAULT_HOSTED_BASE).replace(/\/$/, ""),
        });
      } else {
        log("no config (prefer_hosted:", s.prefer_hosted, "token set:", !!s.hosted_token, ") — silent");
      }
      return;
    }

    showCard(target, { state: "loading" });
    try {
      log("requesting recall_assist via background.js");
      const resp = await sendMessageWithTimeout({
        type: "mnueron:recall_assist",
        text,
        surface: "chrome",
      });
      log("recall_assist resp:", resp);
      if (!resp?.ok) {
        throw new Error(resp?.error || "recall_assist failed");
      }
      const j = resp.result;
      currentOutcomeId = j.outcome_id;
      if (!j.suggestions || j.suggestions.length === 0) {
        log("no suggestions returned — hiding card");
        hideCard();
        return;
      }
      log("rendering", j.suggestions.length, "suggestions");
      showCard(target, { state: "suggestions", result: j });
    } catch (e) {
      log("recall_assist failed:", e?.message);
      showCard(target, {
        state: "error",
        message: e.message ?? "Couldn't load suggestions.",
      });
    }
  }

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
        fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
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
    if (payload.state === "onboarding") {
      const host = payload.hostedUrl || DEFAULT_HOSTED_BASE;
      const tokenUrl = `${host}/account-settings/tokens`;
      const hostLabel = host.replace(/^https?:\/\//, "");
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <strong style="font-size:13px;color:#1e293b;">📚 mnueron — one-time setup</strong>
          <button id="mnueron-close" style="background:none;border:0;cursor:pointer;color:#94a3b8;font-size:16px;line-height:1;">×</button>
        </div>
        <p style="font-size:12px;line-height:1.5;color:#475569;margin:0 0 10px 0;">
          To show suggestions while you type, mnueron needs a hosted bearer token. It takes about a minute.
        </p>
        <ol style="padding-left:18px;margin:0 0 12px 0;font-size:12px;line-height:1.55;color:#334155;">
          <li style="margin-bottom:8px;">
            <strong>Get your token.</strong>
            Open <a href="${escapeHtml(tokenUrl)}" target="_blank" style="color:#7c3aed;text-decoration:none;border-bottom:1px solid #c4b5fd;">${escapeHtml(hostLabel)}/account-settings/tokens</a>
            → "New token". Copy the value (starts with <code style="background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:11px;">mnu_</code>). You only see it once.
          </li>
          <li style="margin-bottom:8px;">
            <strong>Paste it in mnueron Options.</strong>
            Open the Options page → Connection → Hosted token.
          </li>
          <li style="margin-bottom:0;">
            <strong>Save.</strong>
            The connection pill turns green. Next 1.5s typing pause, suggestions show up here.
          </li>
        </ol>
        <div style="display:flex;gap:6px;align-items:center;">
          <button data-act="open-options" style="padding:5px 10px;font-size:12px;background:#7c3aed;color:white;border:0;border-radius:4px;cursor:pointer;font-weight:500;">Open mnueron Options</button>
          <a href="${escapeHtml(tokenUrl)}" target="_blank" style="padding:5px 10px;font-size:12px;background:white;color:#7c3aed;border:1px solid #c4b5fd;border-radius:4px;cursor:pointer;text-decoration:none;">Get a token →</a>
          <span style="margin-left:auto;font-size:10px;color:#94a3b8;">One-time setup</span>
        </div>`;
    }
    const { intent, suggestions } = payload.result;
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

    const openOpts = card.querySelector('[data-act="open-options"]');
    if (openOpts) {
      openOpts.addEventListener("click", async () => {
        try { await chrome.runtime.sendMessage({ type: "mnueron:open_options" }); } catch {}
        hideCard();
      });
    }

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
            const cfg = await getHostedConfig();
            const base = cfg?.baseUrl || DEFAULT_HOSTED_BASE;
            window.open(`${base}/dashboard?memory=${sid}`, "_blank");
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
      await sendMessageWithTimeout({
        type: "mnueron:suggestion_outcome",
        outcome_id: currentOutcomeId,
        action,
        acted_on_id: sid,
      }, 3000);
    } catch {}
  }

  function isInputLike(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT" && (el.type === "text" || el.type === "search")) return true;
    if (el.isContentEditable) return true;
    // Walk up the parent chain: ProseMirror on claude.ai sometimes fires
    // input events on inner spans/divs whose parent is the contenteditable.
    let p = el.parentElement;
    while (p) {
      if (p.isContentEditable) return true;
      p = p.parentElement;
      if (!p || p === document.body) break;
    }
    return false;
  }

  function getInputText(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    if (el.isContentEditable) return el.innerText || "";
    // Walk up to find the contenteditable ancestor and read its text.
    let p = el.parentElement;
    while (p && p !== document.body) {
      if (p.isContentEditable) return p.innerText || "";
      p = p.parentElement;
    }
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
    if (top + cardRect.height > window.innerHeight - 16) {
      top = Math.max(16, rect.top - cardRect.height - 8);
    }
    if (left + 380 > window.innerWidth) left = window.innerWidth - 380 - 16;
    card.style.top = `${top}px`;
    card.style.left = `${left}px`;
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
