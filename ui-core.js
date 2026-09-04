/* =========================================================
   UI CORE — shared chrome used by every feature: page
   switching, the modal/toast that replace native alert/
   confirm/prompt, and small utilities used by more than one
   feature (the accordion card is used by both the item
   ledger and the choice cards).
   ========================================================= */

// ---- DOM refs: the five top-level pages -------------------------------
const titlePage = document.getElementById("title-page");
const storyPage = document.getElementById("story-page");
const endingPage = document.getElementById("ending-page");
const managerPage = document.getElementById("manager-page");
const gmMapPage = document.getElementById("gm-map-page");

// The passage editor (gm-page) isn't one of the page-swapped pages anymore
// — it's a drawer that opens/closes over gm-map-page (see openGmDrawer/
// closeGmDrawer below). It keeps the same id for minimal diff elsewhere.
const gmPage = document.getElementById("gm-page");
const gmDrawerBackdrop = document.getElementById("gm-drawer-backdrop");

function hideAllPages() {
  titlePage.hidden = true;
  storyPage.hidden = true;
  endingPage.hidden = true;
  managerPage.hidden = true;
  gmMapPage.hidden = true;
  // Defensive reset only: normal navigation can't reach hideAllPages()
  // while the drawer's backdrop is up (it blocks clicks to everything
  // else), but if some future code path calls this while the drawer is
  // open, drop it instantly rather than leaving it stranded mid-animation.
  gmPage.hidden = true;
  gmPage.classList.remove("open");
  gmDrawerBackdrop.hidden = true;
  gmDrawerBackdrop.classList.remove("open");
  // The quest journal (player.js) lives outside .book entirely — a
  // sibling in .reading-area, not one of the pages this function
  // otherwise resets — specifically so it can sit beside .book in the
  // layout instead of inside it. That means it's the one piece of
  // story-page-only chrome this function has to reset by hand, or
  // leaving the story would strand it visible next to the title/manager
  // screen. updateQuestUI() (player.js) is what shows it again once
  // there's actually a story with quests to display.
  const questJournalEl = document.getElementById("quest-journal");
  if (questJournalEl) questJournalEl.hidden = true;
}

/* =========================================================
   Passage drawer open/close — same rAF-then-toggle-class trick the
   toast below already uses: hidden is removed first so the browser
   has something laid out to animate, then "open" is added on the
   next frame so the transform actually transitions in instead of
   snapping straight to its end state. Closing reverses that, then
   waits out the transition before re-hiding (so the drawer can't be
   clicked while it's sliding away off-screen).

   That's the narrow-viewport story. On a wide viewport the drawer
   is CSS-docked as a real column next to the map (see the
   `.gm-drawer` media query in style.css) rather than a fixed overlay
   — there's nothing to slide in from off-screen and nothing behind
   it that needs dimming, so isWideDrawerLayout() below skips the
   backdrop and the animation entirely and just toggles `hidden`
   directly. The 1000px breakpoint here has to stay in sync with the
   one in style.css by hand — there's no shared source of truth for
   it, since a CSS media query and a JS matchMedia call can't read
   from the same place without introducing build tooling this project
   deliberately doesn't have (see the top-of-file file:// note).
   ========================================================= */
function isWideDrawerLayout() {
  return window.matchMedia("(min-width: 1000px)").matches;
}

function openGmDrawer() {
  gmPage.hidden = false;
  if (isWideDrawerLayout()) {
    gmDrawerBackdrop.hidden = true; // docked as a column — nothing behind it to dim
    gmPage.classList.add("open");
    return;
  }
  gmDrawerBackdrop.hidden = false;
  requestAnimationFrame(() => {
    gmDrawerBackdrop.classList.add("open");
    gmPage.classList.add("open");
  });
}

function closeGmDrawer() {
  gmDrawerBackdrop.classList.remove("open");
  gmPage.classList.remove("open");
  if (isWideDrawerLayout()) {
    gmDrawerBackdrop.hidden = true;
    gmPage.hidden = true; // collapses straight back to a two-column layout — no slide-out to wait on
    return;
  }
  setTimeout(() => {
    gmDrawerBackdrop.hidden = true;
    gmPage.hidden = true;
  }, 260); // matches the drawer's CSS transition duration
}

/* =========================================================
   Shared modal + toast — replaces native alert/confirm/prompt
   so messages render inside the page instead of a browser popup.
   ========================================================= */
const modalOverlay = document.getElementById("modal-overlay");
const modalMessage = document.getElementById("modal-message");
const modalInput = document.getElementById("modal-input");
const modalCancelBtn = document.getElementById("modal-cancel-btn");
const modalOkBtn = document.getElementById("modal-ok-btn");

function openModal({ message, isPrompt = false, defaultValue = "", showCancel = true }) {
  return new Promise(resolve => {
    modalMessage.textContent = message;
    modalInput.hidden = !isPrompt;
    modalInput.value = defaultValue;
    modalCancelBtn.hidden = !showCancel;
    modalOverlay.hidden = false;

    if (isPrompt) {
      modalInput.focus();
      modalInput.select();
    } else {
      modalOkBtn.focus();
    }

    function cleanup(result) {
      modalOverlay.hidden = true;
      modalOkBtn.removeEventListener("click", onOk);
      modalCancelBtn.removeEventListener("click", onCancel);
      modalInput.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onOk() { cleanup(isPrompt ? modalInput.value : true); }
    function onCancel() { cleanup(isPrompt ? null : false); }
    function onKeydown(e) { if (e.key === "Enter") onOk(); if (e.key === "Escape") onCancel(); }

    modalOkBtn.addEventListener("click", onOk);
    modalCancelBtn.addEventListener("click", onCancel);
    modalInput.addEventListener("keydown", onKeydown);
  });
}

function showAlert(message) {
  return openModal({ message, showCancel: false });
}
function showConfirm(message) {
  return openModal({ message, showCancel: true });
}
function showPrompt(message, defaultValue = "") {
  return openModal({ message, isPrompt: true, defaultValue, showCancel: true });
}

/* ---- Shared "change id" prompt --------------------------------------
   Both the item ledger's "Change id" and the passage id's "Change id"
   need the exact same prompt-then-validate sequence (ask, slugify, reject
   empty/unchanged/duplicate) before whichever fan-out actually happens —
   renameItemId in grimoire-items.js, renameNodeId in grimoire-editor.js.
   Centralizing that sequence here means the validation rules (and their
   wording) can't quietly drift apart between the two over time. Returns
   the cleaned new id, or null if cancelled/invalid/unchanged/taken (an
   explanatory alert has already been shown in the latter two cases). */
async function promptForNewId({ subjectLabel, currentId, existingIds }) {
  const raw = await showPrompt(
    "New id for \u201c" + subjectLabel + "\u201d (letters and numbers only). Every reference to \u201c" + currentId + "\u201d will be updated automatically.",
    currentId
  );
  if (raw === null || !raw.trim()) return null;

  const newId = slugify(raw);
  if (!newId) {
    await showAlert("That id isn't valid once cleaned up to letters and numbers, try something else.");
    return null;
  }
  if (newId === currentId) return null;
  if (existingIds.includes(newId)) {
    await showAlert("\u201c" + newId + "\u201d is already in use.");
    return null;
  }
  return newId;
}

const toastEl = document.getElementById("toast");
let toastTimer = null;
function showToast(message) {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add("show"));
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
    setTimeout(() => { toastEl.hidden = true; }, 250);
  }, 2200);
}

/* ---- Small shared utilities (used by both the satchel popover and the item-picker dropdown) ---- */
function truncate(text, maxLen) {
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

function closeOnOutsideClick(panelEl, triggerEls, onClose) {
  document.addEventListener("click", (e) => {
    if (panelEl.hidden) return;
    if (panelEl.contains(e.target)) return;
    if (triggerEls.some(el => el && el.contains(e.target))) return;
    onClose();
  });
}

/* ---- Shared inline autocomplete dropdown --------------------------------
   One suggestions widget, several backing lists: a choice card's "requires"/
   "grants" fields suggest defined items (grimoire-editor.js), and a quest
   objective's condition target suggests either items or passages depending
   on the condition's type (quest-editor.js). Rather than each feature
   building its own dropdown/mousedown/outside-click plumbing, they all call
   this with a getMatches(query) -> [{id, label}] function and an onPick(id)
   callback, and this owns the actual open/filter/select mechanics.
   mousedown (not click) on a suggestion fires before the input's blur, so
   the picked value commits reliably even though the dropdown is about to
   disappear out from under the cursor. */
function attachAutocomplete(field, input, getMatches, onPick) {
  const dropdown = document.createElement("div");
  dropdown.className = "item-autocomplete";
  dropdown.hidden = true;
  field.appendChild(dropdown);

  function open() {
    const options = getMatches(input.value.trim());
    dropdown.innerHTML = "";

    if (!options || options.length === 0) {
      dropdown.hidden = true;
      return;
    }

    options.forEach(opt => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "item-autocomplete-row";

      const name = document.createElement("span");
      name.textContent = opt.label;
      row.appendChild(name);

      const idTag = document.createElement("span");
      idTag.className = "item-autocomplete-id";
      idTag.textContent = opt.id;
      row.appendChild(idTag);

      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onPick(opt.id);
        dropdown.hidden = true;
      });

      dropdown.appendChild(row);
    });

    dropdown.hidden = false;
  }

  input.addEventListener("focus", open);
  input.addEventListener("input", open);
  closeOnOutsideClick(dropdown, [input], () => { dropdown.hidden = true; });
}

/* ---- Shared accordion card ----------------------------------------------
   Both "item definitions" and "choices" are collapsible cards with the same
   shape: a toggle header (chevron + one-line summary + optional remove
   button) and a body that only exists while expanded. Building that
   scaffolding once here, instead of twice, is what actually keeps the two
   render functions using it short. */
function buildAccordionCard({ isExpanded, onToggle, buildSummary, removeLabel, onRemove, buildBody }) {
  const card = document.createElement("div");
  card.className = "gm-choice-card" + (isExpanded ? " expanded" : "");

  const header = document.createElement("div");
  header.className = "gm-choice-card-header";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "gm-choice-toggle";
  toggle.setAttribute("aria-expanded", String(isExpanded));
  toggle.addEventListener("click", onToggle);

  const chevron = document.createElement("span");
  chevron.className = "gm-choice-chevron";
  chevron.textContent = "▸";
  chevron.setAttribute("aria-hidden", "true");
  toggle.appendChild(chevron);

  const summary = document.createElement("span");
  summary.className = "gm-choice-summary";
  buildSummary(summary);
  toggle.appendChild(summary);
  header.appendChild(toggle);

  if (onRemove) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "gm-remove-choice";
    removeBtn.textContent = removeLabel || "Remove";
    removeBtn.addEventListener("click", onRemove);
    header.appendChild(removeBtn);
  }

  card.appendChild(header);

  if (isExpanded && buildBody) {
    const body = document.createElement("div");
    body.className = "gm-choice-body";
    buildBody(body, summary);
    card.appendChild(body);
  }

  return card;
}
