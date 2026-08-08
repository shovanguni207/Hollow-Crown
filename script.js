/* =========================================================
   THE HOLLOW CROWN — a small branching-story engine
   with a Grimoire: a manager for many saved tales, each
   editable passage-by-passage and playtestable in place.

   STORY SHAPE: { items: {id: {label, description}}, nodes: {id: node} }
   Item definitions live once in `items`; choices only ever
   reference an item by id in `requires`/`grants`. This keeps a
   single source of truth for an item's display name no matter
   how many different choices grant or require it.
   ========================================================= */

// ---- Built-in story ---------------------------------------------
const DEFAULT_STORY = {
  items: {
    key: { label: "Iron Key", description: "Still warm. It hums faintly, as though it remembers a lock." },
    blade: { label: "Captain's Blade", description: "Notched but honest — a soldier's blade, not a looter's." }
  },
  nodes: {
    start: {
      chapter: "I — The Gatehouse",
      text: "The undercroft gate hangs open, its iron teeth rusted mid-bite. Torchlight gutters somewhere below. You could take the wide stair, still warm with the footprints of looters who went before you or the narrow servant's passage, choked with cobwebs and colder air.",
      choices: [
        { label: "Take the wide stair, and whatever waits at its end.", to: "wideStair" },
        { label: "Slip into the servant's passage instead.", to: "narrowPath" }
      ]
    },
    wideStair: {
      chapter: "II — The Wide Stair",
      text: "The steps open into a hall stripped bare, except for a single iron key, still warm, resting on the dead king's overturned throne. Beside it, a captain's blade lies half-buried in ash, its edge notched but honest.",
      choices: [
        { label: "Take the key.", to: "haveKey", grants: { item: "key" } },
        { label: "Take the blade.", to: "haveBlade", grants: { item: "blade" } },
        { label: "Take neither, and go deeper empty-handed.", to: "deeper" }
      ]
    },
    narrowPath: {
      chapter: "II — The Servant's Passage",
      text: "The passage is tight and dark, but it leads you unseen past a sleeping thing that stirs in the wide hall above. You emerge into the lower vault a full turn ahead of any rival looter, though you carry nothing but your own two hands.",
      choices: [
        { label: "Press on into the vault.", to: "deeper" }
      ]
    },
    haveKey: {
      chapter: "III — Descending",
      text: "The key hums faintly against your palm as you descend, as though it remembers a lock it hasn't seen in a hundred years. At the bottom of the stair, the vault door is sealed — but keyholed.",
      choices: [
        { label: "Fit the key to the lock.", to: "goodEnding" },
        { label: "Search for another way in instead.", to: "deeper" }
      ]
    },
    haveBlade: {
      chapter: "III — Descending",
      text: "The blade sits well in your hand, and it's good that it does because something in the dark below is already moving toward the sound of your footsteps.",
      choices: [
        { label: "Stand your ground and fight.", to: "fightEnding" },
        { label: "Run for the vault door.", to: "deeper" }
      ]
    },
    deeper: {
      chapter: "III — The Vault Door",
      text: "You reach the vault door itself: black iron, unmarked, sealed with no visible lock. Whatever opens it, it isn't strength alone.",
      choices: [
        { label: "Use the iron key.", to: "goodEnding", requires: { item: "key" } },
        { label: "Force it with the blade.", to: "fightEnding", requires: { item: "blade" } },
        { label: "Press your palm flat against the cold iron and wait.", to: "waitEnding" }
      ]
    },
    goodEnding: {
      end: true,
      endingType: "The Crown Restored",
      text: "The key turns as if the lock had been waiting a hundred years for exactly this hand. Inside, the crown sits untouched on a cushion of rotted velvet, and beneath it, a note in a script older than the kingdom itself, addressed, somehow, to you."
    },
    fightEnding: {
      end: true,
      endingType: "The Long Way Down",
      text: "The blade earns its keep. What you find past the door isn't a crown, it's a way further down, into passages no looter's map has ever charted. You leave the undercroft with empty hands and a map no one else has."
    },
    waitEnding: {
      end: true,
      endingType: "What the Iron Remembers",
      text: "The door does not open for strength, or for keys. It opens because you asked it nothing and took nothing and the vault, for the first time in a century, decides to simply let someone leave with what they came for: the truth of what happened here."
    }
  }
};

// ---- Global play state ---------------------------------------------
const SAVE_KEY = "hollow-crown-save";
const TALES_KEY = "hollow-crown-tales";
const LEGACY_GM_KEY = "hollow-crown-gm-story"; // single-tale format from an earlier version

let activeStory = DEFAULT_STORY;   // whichever story is currently being played
let mode = "play";                  // "play" | "gm-playtest"

let state = {
  currentNode: "start",
  inventory: []   // array of item ids
};

// ---- DOM refs: play/ending screens -------------------------------------
const titlePage = document.getElementById("title-page");
const storyPage = document.getElementById("story-page");
const endingPage = document.getElementById("ending-page");
const managerPage = document.getElementById("manager-page");
const gmPage = document.getElementById("gm-page");

const chapterLabel = document.getElementById("chapter-label");
const satchelToggle = document.getElementById("satchel-toggle");
const satchelPanel = document.getElementById("satchel-panel");
const satchelCount = document.getElementById("satchel-count");
const satchelList = document.getElementById("satchel-list");
const passageText = document.getElementById("passage-text");
const choicesEl = document.getElementById("choices");

const endingEyebrow = document.getElementById("ending-eyebrow");
const endingTitle = document.getElementById("ending-title");
const endingText = document.getElementById("ending-text");

function hideAllPages() {
  titlePage.hidden = true;
  storyPage.hidden = true;
  endingPage.hidden = true;
  managerPage.hidden = true;
  gmPage.hidden = true;
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

/* =========================================================
   Story playback — shared by the built-in tale and any
   Grimoire tale being read or playtested.
   ========================================================= */
function findItemLabel(itemId) {
  const def = activeStory.items && activeStory.items[itemId];
  return def ? (def.label || itemId) : itemId;
}

function renderInventory() {
  const count = state.inventory.length;

  satchelToggle.hidden = count === 0;
  satchelCount.textContent = String(count);

  satchelList.innerHTML = "";
  state.inventory.forEach(itemId => {
    const li = document.createElement("li");
    li.textContent = findItemLabel(itemId);
    satchelList.appendChild(li);
  });

  if (count === 0) satchelPanel.hidden = true;
}

satchelToggle.addEventListener("click", () => {
  satchelPanel.hidden = !satchelPanel.hidden;
  satchelToggle.setAttribute("aria-expanded", String(!satchelPanel.hidden));
});

closeOnOutsideClick(satchelPanel, [satchelToggle], () => {
  satchelPanel.hidden = true;
  satchelToggle.setAttribute("aria-expanded", "false");
});

function hasItem(itemId) {
  return state.inventory.includes(itemId);
}

function renderNode(nodeId) {
  const node = activeStory.nodes[nodeId];
  if (!node) {
    passageText.textContent = "This passage doesn't exist yet, the tale ends here by accident rather than design.";
    choicesEl.innerHTML = "";
    return;
  }

  state.currentNode = nodeId;
  if (mode === "play") save();

  if (node.end) {
    showEnding(node);
    return;
  }

  hideAllPages();
  storyPage.hidden = false;

  chapterLabel.textContent = node.chapter || "";
  passageText.textContent = node.text || "";
  renderInventory();

  choicesEl.innerHTML = "";
  (node.choices || []).forEach(choice => {
    const locked = choice.requires && !hasItem(choice.requires.item);

    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.type = "button";

    const labelSpan = document.createElement("span");
    labelSpan.textContent = choice.label;
    btn.appendChild(labelSpan);

    if (locked) {
      btn.disabled = true;
      btn.style.opacity = "0.45";
      btn.style.cursor = "not-allowed";
      const note = document.createElement("span");
      note.className = "locked-note";
      note.textContent = "Requires: " + findItemLabel(choice.requires.item);
      btn.appendChild(note);
    }

    btn.addEventListener("click", () => {
      if (choice.grants && !hasItem(choice.grants.item)) {
        state.inventory.push(choice.grants.item);
      }
      renderNode(choice.to);
    });

    choicesEl.appendChild(btn);
  });
}

function showEnding(node) {
  hideAllPages();
  endingPage.hidden = false;

  endingEyebrow.textContent = "the tale ends here";
  endingTitle.textContent = node.endingType || "The End";
  endingText.textContent = node.text || "";
}

function save() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch (e) {}
}

function resetState() {
  state = { currentNode: "start", inventory: [] };
  if (mode === "play") save();
}

document.getElementById("start-btn").addEventListener("click", () => {
  mode = "play";
  activeStory = DEFAULT_STORY;
  resetState();
  renderNode("start");
});

document.getElementById("leave-story-btn").addEventListener("click", () => {
  hideAllPages();
  if (mode === "gm-playtest") { gmPage.hidden = false; } else { titlePage.hidden = false; }
});

document.getElementById("restart-btn").addEventListener("click", () => {
  resetState();
  hideAllPages();
  if (mode === "gm-playtest") { gmPage.hidden = false; } else { titlePage.hidden = false; }
});

/* =========================================================
   GRIMOIRE DATA — a library of many tales, each its own story object.
   Stored as one object keyed by tale id, so the manager can list,
   rename, duplicate, and delete without touching the others.
   ========================================================= */

let tales = loadTales();
let currentTaleId = null;
let gmStory = null;          // always === tales[currentTaleId].story while editing, shape {items, nodes}
let gmSelectedNodeId = "start";
let editingChoices = [];
let expandedChoiceIndex = null; // which choice card (if any) is expanded in the accordion
let expandedItemId = null;      // which item definition (if any) is expanded

function starterStory() {
  return {
    items: {},
    nodes: {
      start: {
        chapter: "I — The Beginning",
        text: "Describe the opening scene here. What does the reader see, and what can they do about it?",
        choices: []
      }
    }
  };
}

// Brings an older-format story up to { items, nodes }. Handles two cases:
// - a flat node map with no wrapper at all (earliest single-tale saves)
// - grants that carried their own {item, label} instead of referencing a registry
function migrateStoryFormat(story) {
  if (story && story.nodes) {
    if (!story.items) story.items = {};
    return story;
  }

  const nodes = story || {};
  const items = {};

  Object.keys(nodes).forEach(nodeId => {
    (nodes[nodeId].choices || []).forEach(choice => {
      if (choice.grants && choice.grants.item) {
        const id = choice.grants.item;
        if (!items[id]) items[id] = { label: choice.grants.label || id, description: "" };
        if (choice.grants.label) delete choice.grants.label; // label now lives only in the registry
      }
    });
  });

  return { items, nodes };
}

function loadTales() {
  let loaded = {};
  try {
    const raw = localStorage.getItem(TALES_KEY);
    if (raw) loaded = JSON.parse(raw);
  } catch (e) {}

  if (Object.keys(loaded).length === 0) {
    // migrate a single-tale save from an earlier version of the Grimoire, if present
    try {
      const legacy = localStorage.getItem(LEGACY_GM_KEY);
      if (legacy) {
        const story = migrateStoryFormat(JSON.parse(legacy));
        const id = "tale-" + Date.now().toString(36);
        loaded = { [id]: { id, title: "My first tale", updatedAt: Date.now(), story } };
        localStorage.removeItem(LEGACY_GM_KEY);
        localStorage.setItem(TALES_KEY, JSON.stringify(loaded));
        return loaded;
      }
    } catch (e) {}
    return loaded;
  }

  // bring every stored tale up to the current { items, nodes } shape
  let migratedAny = false;
  Object.keys(loaded).forEach(id => {
    const before = loaded[id].story;
    const after = migrateStoryFormat(before);
    if (after !== before) migratedAny = true;
    loaded[id].story = after;
  });
  if (migratedAny) {
    try { localStorage.setItem(TALES_KEY, JSON.stringify(loaded)); } catch (e) {}
  }

  return loaded;
}

function saveTales() {
  try { localStorage.setItem(TALES_KEY, JSON.stringify(tales)); } catch (e) {}
}

function slugify(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40);
}

function uniqueTaleId(title) {
  const base = slugify(title) || "tale";
  return base + "-" + Date.now().toString(36);
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/* ---- Manager: the library screen ------------------------------- */
function renderManager() {
  const listEl = document.getElementById("tale-list");
  const emptyEl = document.getElementById("tale-list-empty");
  listEl.innerHTML = "";

  const ids = Object.keys(tales).sort((a, b) => (tales[b].updatedAt || 0) - (tales[a].updatedAt || 0));
  emptyEl.hidden = ids.length > 0;

  ids.forEach(id => {
    const tale = tales[id];
    const nodes = (tale.story && tale.story.nodes) || {};
    const passageCount = Object.keys(nodes).length;
    const endingCount = Object.values(nodes).filter(n => n.end).length;

    const card = document.createElement("div");
    card.className = "tale-card";

    const title = document.createElement("p");
    title.className = "tale-card-title";
    title.textContent = tale.title || "Untitled tale";
    card.appendChild(title);

    const meta = document.createElement("p");
    meta.className = "tale-card-meta";
    meta.textContent = passageCount + " passage" + (passageCount === 1 ? "" : "s") +
      " · " + endingCount + " ending" + (endingCount === 1 ? "" : "s") +
      " · edited " + formatDate(tale.updatedAt || Date.now());
    card.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "tale-card-actions";

    actions.appendChild(makeCardButton("Open", () => openTale(id)));
    actions.appendChild(makeCardButton("Rename", () => renameTale(id)));
    actions.appendChild(makeCardButton("Duplicate", () => duplicateTale(id)));
    actions.appendChild(makeCardButton("Export", () => exportTale(id)));
    actions.appendChild(makeCardButton("Delete", () => deleteTale(id), true));

    card.appendChild(actions);
    listEl.appendChild(card);
  });
}

function makeCardButton(label, onClick, danger = false) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-tiny" + (danger ? " danger" : "");
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function createTale() {
  const title = await showPrompt("Name your new tale:", "Untitled tale");
  if (title === null) return;
  const id = uniqueTaleId(title || "tale");
  tales[id] = { id, title: title.trim() || "Untitled tale", updatedAt: Date.now(), story: starterStory() };
  saveTales();
  openTale(id);
}

async function renameTale(id) {
  const title = await showPrompt("Rename this tale:", tales[id].title);
  if (title === null || !title.trim()) return;
  tales[id].title = title.trim();
  tales[id].updatedAt = Date.now();
  saveTales();
  renderManager();
  if (id === currentTaleId) updateGmTaleBar();
}

async function duplicateTale(id) {
  const copyId = uniqueTaleId(tales[id].title + "-copy");
  tales[copyId] = {
    id: copyId,
    title: tales[id].title + " (copy)",
    updatedAt: Date.now(),
    story: JSON.parse(JSON.stringify(tales[id].story))
  };
  saveTales();
  renderManager();
  showToast("Duplicated \u201c" + tales[id].title + "\u201d.");
}

async function deleteTale(id) {
  const ok = await showConfirm("Delete \u201c" + tales[id].title + "\u201d? This can't be undone.");
  if (!ok) return;
  delete tales[id];
  saveTales();
  renderManager();
  showToast("Tale deleted.");
}

function exportTale(id) {
  const tale = tales[id];
  const blob = new Blob([JSON.stringify(tale.story, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = slugify(tale.title || "tale") + ".json";
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("mgr-new-tale-btn").addEventListener("click", createTale);

document.getElementById("mgr-import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const text = await file.text();
  try {
    const parsed = migrateStoryFormat(JSON.parse(text));
    if (!parsed.nodes || !parsed.nodes.start) throw new Error("no start passage");
    const title = file.name.replace(/\.json$/i, "") || "Imported tale";
    const id = uniqueTaleId(title);
    tales[id] = { id, title, updatedAt: Date.now(), story: parsed };
    saveTales();
    renderManager();
    showToast("Imported \u201c" + title + "\u201d.");
  } catch (err) {
    await showAlert("That file doesn't look like a valid tale. it needs a passage called \u201cstart\u201d at minimum.");
  }
});

document.getElementById("mgr-back-btn").addEventListener("click", () => {
  hideAllPages();
  titlePage.hidden = false;
});

document.getElementById("gm-enter-btn").addEventListener("click", () => {
  hideAllPages();
  managerPage.hidden = false;
  renderManager();
});

/* ---- Editor: one tale, passage by passage ------------------------------- */
function openTale(id) {
  currentTaleId = id;
  gmStory = tales[id].story;
  expandedItemId = null;
  nodeFilterQuery = "";
  document.getElementById("gm-node-search").value = "";
  hideAllPages();
  gmPage.hidden = false;
  updateGmTaleBar();
  selectGmNode(gmStory.nodes[gmSelectedNodeId] ? gmSelectedNodeId : "start");
  renderItemDefs();
}

function updateGmTaleBar() {
  document.getElementById("gm-tale-name").textContent = tales[currentTaleId].title;
}

function touchCurrentTale() {
  tales[currentTaleId].updatedAt = Date.now();
  saveTales();
  renderItemDefs();
}

/* ---- Item Definitions: the single source of truth for item labels -------
   Scans every choice for grants/requires usage (which passages grant an
   item, which require it), so findItemLabel() stays a simple lookup no
   matter how many choices reference the same item. */
function computeItemUsage(story) {
  const usage = {};
  Object.keys(story.nodes).forEach(nodeId => {
    (story.nodes[nodeId].choices || []).forEach(choice => {
      if (choice.grants && choice.grants.item) {
        const id = choice.grants.item;
        if (!usage[id]) usage[id] = { grantedIn: new Set(), requiredIn: new Set() };
        usage[id].grantedIn.add(nodeId);
      }
      if (choice.requires && choice.requires.item) {
        const id = choice.requires.item;
        if (!usage[id]) usage[id] = { grantedIn: new Set(), requiredIn: new Set() };
        usage[id].requiredIn.add(nodeId);
      }
    });
  });
  return usage;
}

/* ---- Shared accordion card ----------------------------------------------
   Both "item definitions" and "choices" are collapsible cards with the same
   shape: a toggle header (chevron + one-line summary + optional remove
   button) and a body that only exists while expanded. Building that
   scaffolding once here, instead of twice, is what actually keeps the two
   render functions below short. */
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

/* ---- Item Definitions: the single source of truth for item labels ------- */
function renderItemDefs() {
  const wrap = document.getElementById("item-defs-list");
  if (!wrap || !gmStory) return;
  wrap.innerHTML = "";

  if (!gmStory.items) gmStory.items = {};
  const usage = computeItemUsage(gmStory);
  const definedIds = Object.keys(gmStory.items);
  const undefinedIds = Object.keys(usage).filter(id => !gmStory.items[id]);

  if (definedIds.length === 0 && undefinedIds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ledger-empty";
    empty.textContent = "No items yet, define one below, then reference its id in a choice's \u201cgrants\u201d or \u201crequires\u201d field.";
    wrap.appendChild(empty);
    return;
  }

  definedIds.forEach(id => wrap.appendChild(buildItemDefCard(id, usage[id])));
  undefinedIds.forEach(id => wrap.appendChild(buildUndefinedItemRow(id, usage[id])));
}

function buildItemDefCard(id, usage) {
  const def = gmStory.items[id];
  const granted = usage ? usage.grantedIn.size : 0;
  const required = usage ? usage.requiredIn.size : 0;
  const neverGranted = required > 0 && granted === 0;

  return buildAccordionCard({
    isExpanded: expandedItemId === id,
    onToggle: () => {
      expandedItemId = expandedItemId === id ? null : id;
      renderItemDefs();
    },
    removeLabel: "Delete",
    onRemove: async () => {
      const ok = await showConfirm("Delete the item \u201c" + (def.label || id) + "\u201d? Any choice still referencing \u201c" + id + "\u201d will show it as undefined.");
      if (!ok) return;
      delete gmStory.items[id];
      if (expandedItemId === id) expandedItemId = null;
      touchCurrentTale();
    },
    buildSummary: (summary) => {
      const mark = document.createElement("span");
      mark.className = "item-mark";
      mark.textContent = "◆";
      mark.setAttribute("aria-hidden", "true");
      summary.appendChild(mark);

      summary.appendChild(document.createTextNode((def.label || id) + " (" + id + ")"));

      const grantedTag = document.createElement("span");
      grantedTag.className = "tag-pill";
      grantedTag.textContent = "granted×" + granted;
      summary.appendChild(grantedTag);

      const requiredTag = document.createElement("span");
      requiredTag.className = "tag-pill" + (neverGranted ? " warning" : "");
      requiredTag.textContent = "required×" + required;
      summary.appendChild(requiredTag);

      if (def.description) {
        const desc = document.createElement("span");
        desc.className = "arrow";
        desc.textContent = " — " + truncate(def.description, 60);
        summary.appendChild(desc);
      }
    },
    buildBody: (body) => {
      const idField = document.createElement("label");
      idField.className = "gm-choice-field";
      idField.textContent = "Item id";
      const idInput = document.createElement("input");
      idInput.type = "text";
      idInput.value = id;
      idInput.disabled = true;
      idField.appendChild(idInput);
      body.appendChild(idField);

      const labelField = document.createElement("label");
      labelField.className = "gm-choice-field";
      labelField.textContent = "Display name";
      const labelInput = document.createElement("input");
      labelInput.type = "text";
      labelInput.value = def.label || "";
      labelInput.addEventListener("change", () => {
        def.label = labelInput.value.trim() || id;
        touchCurrentTale();
      });
      labelField.appendChild(labelInput);
      body.appendChild(labelField);

      const descField = document.createElement("label");
      descField.className = "gm-choice-field";
      descField.textContent = "Description (optional)";
      const descInput = document.createElement("input");
      descInput.type = "text";
      descInput.value = def.description || "";
      descInput.addEventListener("change", () => {
        def.description = descInput.value.trim();
        touchCurrentTale();
      });
      descField.appendChild(descInput);
      body.appendChild(descField);

      if (neverGranted) {
        const warn = document.createElement("p");
        warn.className = "hint";
        warn.style.textAlign = "left";
        warn.style.color = "var(--blood)";
        warn.textContent = "This item is required somewhere but no choice grants it yet.";
        body.appendChild(warn);
      }
    }
  });
}

function buildUndefinedItemRow(id, usage) {
  const row = document.createElement("div");
  row.className = "ledger-row";

  const name = document.createElement("span");
  name.className = "item-name";
  name.textContent = id;
  row.appendChild(name);

  const tag = document.createElement("span");
  tag.className = "tag-pill warning";
  tag.textContent = "used but undefined";
  row.appendChild(tag);

  const stat = document.createElement("span");
  stat.className = "tag-pill";
  stat.textContent = "granted×" + usage.grantedIn.size + " · required×" + usage.requiredIn.size;
  row.appendChild(stat);

  const defineBtn = document.createElement("button");
  defineBtn.type = "button";
  defineBtn.className = "btn-tiny";
  defineBtn.textContent = "+ Define";
  defineBtn.addEventListener("click", () => {
    gmStory.items[id] = { label: id, description: "" };
    expandedItemId = id;
    touchCurrentTale();
  });
  row.appendChild(defineBtn);

  return row;
}

document.getElementById("item-def-new").addEventListener("click", async () => {
  const raw = await showPrompt("Id for the new item (letters and numbers only, e.g. 'castleKey'):");
  if (raw === null || !raw.trim()) return;
  const id = slugify(raw) || ("item" + Date.now());
  if (!gmStory.items) gmStory.items = {};
  if (gmStory.items[id]) {
    showToast("An item with that id already exists, opening it.");
    expandedItemId = id;
    renderItemDefs();
    return;
  }
  gmStory.items[id] = { label: raw.trim(), description: "" };
  expandedItemId = id;
  touchCurrentTale();
});

let nodeFilterQuery = "";

// One graph walk serves two purposes: the order IS roughly reading order
// (breadth-first from start), and whatever's left unvisited is, by
// definition, unreachable from the start of the tale — i.e. orphaned.
function analyzeStoryFlow(story) {
  const order = [];
  const reachable = new Set();
  const queue = story.nodes.start ? ["start"] : [];

  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id) || !story.nodes[id]) continue;
    reachable.add(id);
    order.push(id);
    (story.nodes[id].choices || []).forEach(c => {
      if (c.to && !reachable.has(c.to)) queue.push(c.to);
    });
  }

  // orphaned passages: append at the end, in their original order
  Object.keys(story.nodes).forEach(id => {
    if (!reachable.has(id)) order.push(id);
  });

  return { order, reachable };
}

function passageTitle(node) {
  if (node.chapter && node.chapter.trim()) return { text: node.chapter, placeholder: false };
  if (node.end && node.endingType) return { text: node.endingType, placeholder: false };
  return { text: "(untitled passage)", placeholder: true };
}

function renderGmNodeList() {
  const listEl = document.getElementById("gm-node-list");
  listEl.innerHTML = "";

  const { order, reachable } = analyzeStoryFlow(gmStory);
  const query = nodeFilterQuery.trim().toLowerCase();

  const visible = order.filter(id => {
    if (!query) return true;
    const node = gmStory.nodes[id];
    const haystack = (id + " " + (node.chapter || "") + " " + (node.text || "")).toLowerCase();
    return haystack.includes(query);
  });

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "ledger-empty";
    empty.textContent = query
      ? "No passages match \u201c" + nodeFilterQuery.trim() + "\u201d."
      : "No passages yet.";
    listEl.appendChild(empty);
    return;
  }

  visible.forEach(id => {
    const node = gmStory.nodes[id];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "gm-node-item" + (id === gmSelectedNodeId ? " active" : "");

    const { text: titleText, placeholder } = passageTitle(node);
    const title = document.createElement("span");
    title.className = "gm-node-item-title" + (placeholder ? " placeholder" : "");
    title.textContent = titleText;
    item.appendChild(title);

    const meta = document.createElement("span");
    meta.className = "gm-node-item-meta";

    const idTag = document.createElement("span");
    idTag.className = "node-tag";
    idTag.textContent = id;
    meta.appendChild(idTag);

    if (id === "start") meta.appendChild(makeNodeBadge("start"));
    if (node.end) meta.appendChild(makeNodeBadge("ending"));
    if (!reachable.has(id)) meta.appendChild(makeNodeBadge("orphaned", true));

    item.appendChild(meta);

    item.addEventListener("click", () => selectGmNode(id));
    listEl.appendChild(item);
  });
}

function makeNodeBadge(text, warning) {
  const badge = document.createElement("span");
  badge.className = "tag-pill" + (warning ? " warning" : "");
  badge.textContent = text;
  return badge;
}

document.getElementById("gm-node-search").addEventListener("input", (e) => {
  nodeFilterQuery = e.target.value;
  renderGmNodeList();
});

function selectGmNode(id) {
  gmSelectedNodeId = id;
  const node = gmStory.nodes[id] || { chapter: "", text: "", choices: [] };

  document.getElementById("gm-node-id").value = id;
  document.getElementById("gm-chapter").value = node.chapter || "";
  document.getElementById("gm-text").value = node.text || "";
  document.getElementById("gm-is-ending").checked = !!node.end;
  document.getElementById("gm-ending-type").value = node.endingType || "";

  editingChoices = (node.choices || []).map(c => ({
    label: c.label || "",
    to: c.to || "",
    requires: (c.requires && c.requires.item) || "",
    grantsItem: (c.grants && c.grants.item) || ""
  }));
  expandedChoiceIndex = null;

  toggleEndingFields();
  renderChoiceRows();
  renderGmNodeList();
}

function toggleEndingFields() {
  const isEnding = document.getElementById("gm-is-ending").checked;
  document.getElementById("gm-ending-fields").hidden = !isEnding;
  document.getElementById("gm-choices-block").hidden = isEnding;
}
document.getElementById("gm-is-ending").addEventListener("change", toggleEndingFields);

// ---- Choice cards (accordion: collapsed summary, tap to edit) -------------------------------
// itemPicker: true marks the two fields that reference an item id, so
// makeChoiceField knows to attach the autocomplete dropdown to them.
const CHOICE_FIELD_SPEC = [
  { key: "label",      label: "Choice text" },
  { key: "to",          label: "Leads to (passage id)" },
  { key: "requires",    label: "Requires item id (optional)", itemPicker: true },
  { key: "grantsItem",  label: "Grants item id (optional)",   itemPicker: true }
];

function choiceSummaryText(choice) {
  const label = choice.label.trim() ? '"' + truncate(choice.label, 46) + '"' : null;
  return { label, to: choice.to.trim() || null };
}

function buildChoiceSummary(summaryEl, choice, index) {
  summaryEl.innerHTML = "";

  const n = document.createElement("span");
  n.className = "n";
  n.textContent = "Choice " + (index + 1);
  summaryEl.appendChild(n);

  const { label, to } = choiceSummaryText(choice);
  if (label) {
    summaryEl.appendChild(document.createTextNode(label));
  } else {
    const ph = document.createElement("span");
    ph.className = "placeholder";
    ph.textContent = "Untitled choice";
    summaryEl.appendChild(ph);
  }
  if (to) {
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = " → " + to;
    summaryEl.appendChild(arrow);
  }
}

function renderChoiceRows() {
  const wrap = document.getElementById("gm-choices-list");
  wrap.innerHTML = "";

  if (editingChoices.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.style.textAlign = "left";
    empty.textContent = "No choices yet, add one so the reader has somewhere to go from here.";
    wrap.appendChild(empty);
    return;
  }

  editingChoices.forEach((choice, i) => {
    const isExpanded = expandedChoiceIndex === i;

    const card = buildAccordionCard({
      isExpanded,
      onToggle: () => {
        expandedChoiceIndex = isExpanded ? null : i;
        renderChoiceRows();
      },
      removeLabel: "Remove",
      onRemove: () => {
        editingChoices.splice(i, 1);
        if (expandedChoiceIndex === i) expandedChoiceIndex = null;
        else if (expandedChoiceIndex > i) expandedChoiceIndex -= 1;
        renderChoiceRows();
      },
      buildSummary: (summary) => buildChoiceSummary(summary, choice, i),
      buildBody: (body, summary) => {
        CHOICE_FIELD_SPEC.forEach(spec => {
          body.appendChild(
            makeChoiceField(spec, choice[spec.key], v => {
              choice[spec.key] = v;
              buildChoiceSummary(summary, choice, i);
            })
          );
        });
      }
    });

    wrap.appendChild(card);
  });
}

function makeChoiceField(spec, value, onChange) {
  const field = document.createElement("label");
  field.className = "gm-choice-field";
  field.textContent = spec.label;

  const input = document.createElement("input");
  input.type = "text";
  input.value = value;
  input.autocomplete = "off";
  input.addEventListener("input", () => onChange(input.value));

  field.appendChild(input);
  if (spec.itemPicker) attachItemAutocomplete(field, input);
  return field;
}

/* ---- Item-picker dropdown: suggests defined items as you type into
   a "requires"/"grants" field, so authors reference existing items by
   name instead of retyping (and potentially mistyping) an id. ---- */
function attachItemAutocomplete(field, input) {
  const dropdown = document.createElement("div");
  dropdown.className = "item-autocomplete";
  dropdown.hidden = true;
  field.appendChild(dropdown);

  function matches() {
    const query = input.value.trim().toLowerCase();
    const ids = Object.keys((gmStory && gmStory.items) || {});
    return ids
      .filter(id => !query || id.toLowerCase().includes(query) || (gmStory.items[id].label || "").toLowerCase().includes(query))
      .slice(0, 8);
  }

  function open() {
    const ids = matches();
    dropdown.innerHTML = "";

    if (ids.length === 0) {
      dropdown.hidden = true;
      return;
    }

    ids.forEach(id => {
      const def = gmStory.items[id];
      const row = document.createElement("button");
      row.type = "button";
      row.className = "item-autocomplete-row";

      const name = document.createElement("span");
      name.textContent = def.label || id;
      row.appendChild(name);

      const idTag = document.createElement("span");
      idTag.className = "item-autocomplete-id";
      idTag.textContent = id;
      row.appendChild(idTag);

      // mousedown (not click) fires before the input's blur, so the value commits reliably
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = id;
        input.dispatchEvent(new Event("input"));
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

document.getElementById("gm-add-choice").addEventListener("click", () => {
  editingChoices.push({ label: "", to: "", requires: "", grantsItem: "" });
  expandedChoiceIndex = editingChoices.length - 1; // open the new one straight away
  renderChoiceRows();
});

// ---- New / delete passage -------------------------------
document.getElementById("gm-new-node").addEventListener("click", async () => {
  const raw = await showPrompt("Id for the new passage (letters and numbers only, e.g. 'throneRoom'):");
  if (raw === null || !raw.trim()) return;
  const id = slugify(raw) || ("passage" + Date.now());
  if (gmStory.nodes[id]) {
    showToast("A passage with that id already exists — opening it.");
    selectGmNode(id);
    return;
  }
  gmStory.nodes[id] = { chapter: "", text: "", choices: [] };
  touchCurrentTale();
  selectGmNode(id);
});

document.getElementById("gm-delete-node").addEventListener("click", async () => {
  if (gmSelectedNodeId === "start") {
    await showAlert("The start passage can't be deleted, every tale needs a beginning.");
    return;
  }
  const ok = await showConfirm("Delete this passage? Choices in other passages that lead here won't be fixed automatically.");
  if (!ok) return;
  delete gmStory.nodes[gmSelectedNodeId];
  touchCurrentTale();
  selectGmNode("start");
  showToast("Passage deleted.");
});

// ---- Save passage -------------------------------
document.getElementById("gm-save-node").addEventListener("click", () => {
  const id = gmSelectedNodeId;
  const isEnding = document.getElementById("gm-is-ending").checked;
  const chapter = document.getElementById("gm-chapter").value.trim();
  const text = document.getElementById("gm-text").value.trim();

  if (isEnding) {
    gmStory.nodes[id] = {
      chapter,
      end: true,
      endingType: document.getElementById("gm-ending-type").value.trim() || "The End",
      text: text
    };
  } else {
    const choices = editingChoices
      .filter(c => c.label.trim() && c.to.trim())
      .map(c => {
        const out = { label: c.label.trim(), to: c.to.trim() };
        if (c.requires.trim()) out.requires = { item: c.requires.trim() };
        if (c.grantsItem.trim()) out.grants = { item: c.grantsItem.trim() };
        return out;
      });
    gmStory.nodes[id] = { chapter, text, choices };
  }

  touchCurrentTale();
  renderGmNodeList();
  showToast("Passage saved.");
});

// ---- Playtest -------------------------------
document.getElementById("gm-playtest-btn").addEventListener("click", async () => {
  if (!gmStory.nodes.start) {
    await showAlert("Your tale needs a passage with the id 'start' before you can playtest it.");
    return;
  }
  mode = "gm-playtest";
  activeStory = gmStory;
  state = { currentNode: "start", inventory: [] };
  renderNode("start");
});

// ---- Export current tale / rename / navigate back -------------------------------
document.getElementById("gm-export-btn").addEventListener("click", () => exportTale(currentTaleId));

document.getElementById("gm-rename-tale-btn").addEventListener("click", () => renameTale(currentTaleId));

document.getElementById("gm-back-btn").addEventListener("click", () => {
  hideAllPages();
  managerPage.hidden = false;
  renderManager();
});
