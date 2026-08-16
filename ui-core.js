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
}

/* =========================================================
   Passage drawer open/close — same rAF-then-toggle-class trick the
   toast below already uses: hidden is removed first so the browser
   has something laid out to animate, then "open" is added on the
   next frame so the transform actually transitions in instead of
   snapping straight to its end state. Closing reverses that, then
   waits out the transition before re-hiding (so the drawer can't be
   clicked while it's sliding away off-screen).
   ========================================================= */
function openGmDrawer() {
  gmDrawerBackdrop.hidden = false;
  gmPage.hidden = false;
  requestAnimationFrame(() => {
    gmDrawerBackdrop.classList.add("open");
    gmPage.classList.add("open");
  });
}

function closeGmDrawer() {
  gmDrawerBackdrop.classList.remove("open");
  gmPage.classList.remove("open");
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