/* gx-dev documentation search — dependency-free ranked substring search.
   Reads window.GX_SEARCH from assets/search-index.js; self-initializes. */
(() => {
  "use strict";

  const INDEX = Array.isArray(window.GX_SEARCH) ? window.GX_SEARCH : [];
  const MAX_RESULTS = 12;

  const escapeHtml = (value) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // --- Build the panel once -------------------------------------------------
  const panel = document.createElement("div");
  panel.className = "search-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <div class="search-backdrop" data-search-close></div>
    <div class="search-dialog" role="dialog" aria-modal="true" aria-label="Search documentation">
      <div class="search-bar">
        <span class="search-glyph" aria-hidden="true">⌕</span>
        <input class="search-input" type="search" placeholder="Search the documentation…" aria-label="Search documentation" autocomplete="off">
        <button class="icon-button" type="button" data-search-close aria-label="Close search">✕</button>
      </div>
      <div class="search-hint">
        <span><kbd>/</kbd> opens · <kbd>Esc</kbd> closes · <kbd>Enter</kbd> opens first result</span>
        <span data-search-count aria-live="polite"></span>
      </div>
      <ul class="search-results"></ul>
    </div>`;
  document.body.appendChild(panel);

  const input = panel.querySelector(".search-input");
  const resultsList = panel.querySelector(".search-results");
  const countLabel = panel.querySelector("[data-search-count]");
  let lastFocus = null;

  const tokenize = (query) =>
    query.toLowerCase().split(/\s+/).filter((token) => token.length > 0);

  const countOccurrences = (haystack, needle) => {
    if (!needle) return 0;
    let count = 0;
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      count += 1;
      at = haystack.indexOf(needle, at + needle.length);
    }
    return count;
  };

  const scoreEntry = (entry, tokens) => {
    const title = entry.title.toLowerCase();
    const heading = (entry.heading || "").toLowerCase();
    const text = (entry.text || "").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      const inTitle = countOccurrences(title, token);
      const inHeading = countOccurrences(heading, token);
      const inText = countOccurrences(text, token);
      if (inTitle + inHeading + inText === 0) return 0; // AND semantics
      score += inTitle * 8 + inHeading * 4 + inText;
      if (title.startsWith(token) || new RegExp("\\b" + escapeRegExp(token)).test(title)) score += 2;
    }
    return score;
  };

  const highlight = (value, tokens) => {
    if (!tokens.length || !value) return escapeHtml(value || "");
    const pattern = new RegExp("(" + tokens.map(escapeRegExp).join("|") + ")", "gi");
    return escapeHtml(value).replace(pattern, "<mark>$1</mark>");
  };

  const snippet = (entry, tokens) => {
    const text = entry.text || "";
    if (!tokens.length) return text.slice(0, 140);
    let at = -1;
    for (const token of tokens) {
      const found = text.toLowerCase().indexOf(token);
      if (found !== -1 && (at === -1 || found < at)) at = found;
    }
    if (at === -1) return text.slice(0, 140);
    const start = Math.max(0, at - 45);
    const end = Math.min(text.length, at + 95);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
  };

  const render = (query) => {
    const tokens = tokenize(query);
    resultsList.innerHTML = "";
    if (!tokens.length) {
      resultsList.innerHTML = '<li class="search-empty">Type to search all pages — commands, gates, schemas, configuration, security.</li>';
      countLabel.textContent = "";
      return;
    }
    const hits = INDEX
      .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS);

    countLabel.textContent = hits.length === 0 ? "No matches" : `${hits.length} result${hits.length === 1 ? "" : "s"}`;

    if (!hits.length) {
      resultsList.innerHTML = '<li class="search-empty">No results. Try fewer or different words.</li>';
      return;
    }
    for (const { entry } of hits) {
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = entry.page + (entry.anchor || "");
      link.innerHTML =
        `<span class="hit-page">${highlight(entry.title, tokens)}</span> ` +
        `<span class="hit-heading">— ${highlight(entry.heading, tokens)}</span>` +
        `<span class="hit-snippet">${highlight(snippet(entry, tokens), tokens)}</span>`;
      li.appendChild(link);
      resultsList.appendChild(li);
    }
  };

  const focusables = () =>
    Array.from(panel.querySelectorAll('button, input, a[href]')).filter((el) => el.offsetParent !== null);

  const open = () => {
    lastFocus = document.activeElement;
    panel.hidden = false;
    panel.classList.add("open");
    document.body.classList.add("search-open");
    input.value = "";
    render("");
    input.focus();
  };

  const close = () => {
    panel.classList.remove("open");
    panel.hidden = true;
    document.body.classList.remove("search-open");
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  };

  // --- Wiring ---------------------------------------------------------------
  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-search-toggle]")) open();
    if (event.target.closest("[data-search-close]")) close();
  });

  document.addEventListener("keydown", (event) => {
    const open_ = !panel.hidden;
    if (event.key === "Escape" && open_) {
      event.preventDefault();
      close();
      return;
    }
    if (!open_ && event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT" && !(document.activeElement && document.activeElement.isContentEditable)) {
        event.preventDefault();
        open();
      }
      return;
    }
    if (open_ && event.key === "Tab") {
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  input.addEventListener("input", () => render(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      const first = resultsList.querySelector("a");
      if (first) {
        event.preventDefault();
        window.location.href = first.getAttribute("href");
        close();
      }
    }
  });

  resultsList.addEventListener("click", (event) => {
    if (event.target.closest("a")) close();
  });
})();
