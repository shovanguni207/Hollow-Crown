/* =========================================================
   GRIMOIRE MANAGER — the tale library screen, plus
   tale-level lifecycle: open, rename, duplicate, export,
   delete, import, and the two navigation points (map ↔
   library) that live outside the passage editor itself.
   ========================================================= */

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

    const flourish = document.createElement("span");
    flourish.className = "corner-flourish tl";
    flourish.textContent = "\u25c6";
    flourish.setAttribute("aria-hidden", "true");
    card.appendChild(flourish);

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

    // Play — full width, the one action that works on every device
    // (the editor itself is desktop-only, see .gm-mobile-block), so it
    // gets the most prominent spot and its own color rather than
    // competing with the many other gold buttons on this screen.
    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "tale-card-play-btn";
    const playIcon = document.createElement("span");
    playIcon.className = "tale-card-btn-icon";
    playIcon.textContent = "\u25b6";
    playIcon.setAttribute("aria-hidden", "true");
    playBtn.appendChild(playIcon);
    playBtn.appendChild(document.createTextNode("Play Tale"));
    playBtn.addEventListener("click", () => playTaleFromLibrary(id));
    card.appendChild(playBtn);

    // Open Editor + overflow ("\u22ef") menu holding the housekeeping
    // actions (Rename/Duplicate/Export/Delete) that don't need to be
    // one-tap-visible on every card.
    const secondaryRow = document.createElement("div");
    secondaryRow.className = "tale-card-secondary-row";

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "tale-card-open-btn";
    const openIcon = document.createElement("span");
    openIcon.className = "tale-card-btn-icon";
    openIcon.textContent = "\u270e";
    openIcon.setAttribute("aria-hidden", "true");
    openBtn.appendChild(openIcon);
    openBtn.appendChild(document.createTextNode("Open Editor"));
    openBtn.addEventListener("click", () => openTale(id));
    secondaryRow.appendChild(openBtn);

    const overflowBtn = document.createElement("button");
    overflowBtn.type = "button";
    overflowBtn.className = "tale-card-overflow-btn";
    overflowBtn.textContent = "\u22ef";
    overflowBtn.setAttribute("aria-label", "More actions for " + (tale.title || "this tale"));
    overflowBtn.setAttribute("aria-expanded", "false");

    const overflowMenu = document.createElement("div");
    overflowMenu.className = "tale-card-overflow-menu";
    overflowMenu.hidden = true;
    overflowMenu.appendChild(makeOverflowMenuItem("Rename", () => renameTale(id), overflowMenu));
    overflowMenu.appendChild(makeOverflowMenuItem("Duplicate", () => duplicateTale(id), overflowMenu));
    overflowMenu.appendChild(makeOverflowMenuItem("Export", () => exportTale(id), overflowMenu));
    overflowMenu.appendChild(makeOverflowMenuItem("Delete", () => deleteTale(id), overflowMenu, true));

    overflowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = overflowMenu.hidden;
      // Only one menu open at a time — close any other card's before opening this one.
      document.querySelectorAll(".tale-card-overflow-menu:not([hidden])").forEach(m => { m.hidden = true; });
      overflowMenu.hidden = !willOpen;
      overflowBtn.setAttribute("aria-expanded", String(willOpen));
    });

    secondaryRow.appendChild(overflowBtn);
    secondaryRow.appendChild(overflowMenu);
    card.appendChild(secondaryRow);

    listEl.appendChild(card);
  });
}

// One listener, registered once at load — NOT per-card via
// closeOnOutsideClick (ui-core.js), which is fine for one-off static
// elements like the satchel panel but wrong here: renderManager() rebuilds
// every card from scratch on every rename/duplicate/delete/import, and
// closeOnOutsideClick attaches a fresh document-level listener each time
// it's called, so a per-card registration would leak one stale listener,
// referencing detached DOM, on every single render. This checks all open
// menus against wherever the click landed instead.
document.addEventListener("click", (e) => {
  document.querySelectorAll(".tale-card-overflow-menu:not([hidden])").forEach(menu => {
    if (menu.contains(e.target)) return;
    const toggle = menu.previousElementSibling;
    if (toggle && toggle.contains(e.target)) return;
    menu.hidden = true;
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  });
});

function makeOverflowMenuItem(label, onClick, menuEl, danger) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tale-card-overflow-item" + (danger ? " danger" : "");
  btn.textContent = label;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menuEl.hidden = true;
    onClick();
  });
  return btn;
}

// The mobile-friendly path: the Grimoire editor itself is desktop-only
// (see .gm-mobile-block in index.html), but reading a tale never needed to
// be, so this launches straight into the player without ever opening the
// editor — currentTaleId/gmStory are untouched, and mode "library-play"
// (see player.js's backToStoryOrigin) routes "Leave"/"Restart" back here
// instead of into an editor a phone user can't reach anyway.
async function playTaleFromLibrary(id) {
  const story = tales[id].story;
  if (!story.nodes.start) {
    await showAlert("This tale needs a passage with the id \u2018start\u2019 before it can be played.");
    return;
  }
  mode = "library-play";
  activeStory = story;
  state = freshPlayState();
  renderNode("start");
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

/* ---- Opening / leaving one tale ------------------------------- */
// Opening a tale now lands on the map (NodeGraph.render(), in graph.js)
// rather than jumping straight into a passage form — the map is the new
// entry point, and the passage editor is one node-click away from it.
function openTale(id) {
  currentTaleId = id;
  gmStory = tales[id].story;
  expandedItemId = null;
  expandedQuestId = null;
  gmInspectorSelection = null;
  nodeDrafts = {};
  gmEditorLoaded = false;
  hideAllPages();
  gmMapPage.hidden = false;
  updateGmTaleBar();
  renderItemDefs();
  setGmView("graph"); // always land on the graph, whichever tool was open last time
  NodeGraph.render({ resetView: true });
}

/* ---- View switcher: Graph / Quests / World Map --------------------
   Three tools sharing one tale rather than three separate destinations —
   see the discuss-before-implement conversation this came out of. Only one
   tool's toolbar + canvas pair is visible at a time; the tale identity row,
   Contents sidebar, and passage drawer stay mounted underneath regardless
   of which tab is active, since quests and map locations both reference
   passages the same way the graph does.
   Each tool gets a render call on first switch-to (a tool that's never
   been opened for this tale has nothing built yet) — QuestEditor/MapEditor
   are expected to no-op safely if called again on a later switch, same as
   NodeGraph.render() already does. */
const GM_VIEWS = {
  graph:  { tab: "gm-view-tab-graph",  toolbar: "gm-graph-toolbar",    viewport: "graph-viewport" },
  quests: { tab: "gm-view-tab-quests", toolbar: "gm-quest-toolbar",    viewport: "quest-viewport" },
  map:    { tab: "gm-view-tab-map",    toolbar: "gm-worldmap-toolbar", viewport: "map-editor-viewport" }
};

function setGmView(view) {
  if (!GM_VIEWS[view]) view = "graph";

  // The passage drawer only makes sense over the Graph canvas — leaving it
  // open while switching to Quests/World Map used to just leave it floating
  // there (hideAllPages()/page-swap logic never runs on a tab switch, only
  // on a full page change, so nothing was ever telling it to close). Route
  // through the same commit-then-close path the drawer's own close button
  // uses, so an in-progress passage edit still gets saved rather than
  // silently discarded.
  if (view !== "graph" && !gmPage.hidden) closePassageDrawer();

  gmActiveView = view;

  Object.keys(GM_VIEWS).forEach(key => {
    const cfg = GM_VIEWS[key];
    const active = key === view;
    document.getElementById(cfg.tab).classList.toggle("active", active);
    document.getElementById(cfg.tab).setAttribute("aria-selected", String(active));
    document.getElementById(cfg.toolbar).hidden = !active;
    document.getElementById(cfg.viewport).hidden = !active;
  });

  // Inspector is Quests-only for now — see quest-editor.js. Toggled here
  // rather than folded into GM_VIEWS since it isn't a per-view canvas, it's
  // a second panel alongside one specific view's canvas.
  document.getElementById("quest-inspector").hidden = (view !== "quests");

  // Contents sidebar is shared chrome, but what it shows isn't — a
  // passage/group tree makes sense for Graph, a quest list makes sense for
  // Quests. QuestEditor.render() populates its own version as part of its
  // normal render pass; everywhere else, restore the passage tree (World
  // Map has no location list yet, so it gets the same fallback until it
  // does).
  if (view === "quests") {
    QuestEditor.render();
  } else {
    NodeGraph.renderContentsSidebar();
    document.getElementById("gm-contents-heading").textContent = "Contents";
  }
  if (view === "map") MapEditor.render();
}

Object.keys(GM_VIEWS).forEach(key => {
  document.getElementById(GM_VIEWS[key].tab).addEventListener("click", () => setGmView(key));
});

// Opens the passage drawer over the map for one node — the map stays
// mounted and visible (dimmed) underneath instead of being swapped away.
function enterPassageEditor(id) {
  openGmDrawer();
  selectGmNode(gmStory.nodes[id] ? id : "start");
}

// Closes the passage drawer, committing whatever's in the open form first —
// the map (and playtest, and export) all read gmStory directly, so leaving
// via a route that only drafted the change (instead of saving it) used to
// let the map silently show stale data with no indication anything was
// left unsaved. Re-renders the map underneath so it reflects whatever just
// changed (title, choice count, new/broken wires) once the drawer clears.
function closePassageDrawer() {
  commitCurrentPassage();
  closeGmDrawer();
  NodeGraph.render();
}

document.getElementById("gm-drawer-close").addEventListener("click", closePassageDrawer);
gmDrawerBackdrop.addEventListener("click", closePassageDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !gmPage.hidden) closePassageDrawer();
});

// gm-tale-name (the drawer's own tale-bar) is gone along with the sidebar;
// the map topbar's tale name is the only one left to keep in sync.
function updateGmTaleBar() {
  document.getElementById("gm-map-tale-name").textContent = tales[currentTaleId].title;
}

function touchCurrentTale() {
  tales[currentTaleId].updatedAt = Date.now();
  saveTales();
  renderItemDefs();
  // Same reasoning as renderItemDefs() above: a rename elsewhere (a
  // passage or item id changing) can silently update a quest condition's
  // target out from under an already-rendered card. Only worth doing while
  // Quests is actually the visible tab — QuestEditor.render() runs anyway
  // the moment someone switches to it (see setGmView), so this is purely
  // about not showing stale text if they're looking at it *right now*.
  if (gmActiveView === "quests") QuestEditor.render();
}

document.getElementById("gm-map-export-btn").addEventListener("click", () => exportTale(currentTaleId));

document.getElementById("gm-map-rename-tale-btn").addEventListener("click", () => renameTale(currentTaleId));

document.getElementById("gm-map-back-btn").addEventListener("click", () => {
  nodeDrafts = {}; // leaving the tale entirely: any unsaved passage edits are discarded here, by design
  hideAllPages();
  managerPage.hidden = false;
  renderManager();
});

// The phone-width block's own "All tales" button (see .gm-mobile-block in
// style.css) — just forwards to the real back button above rather than
// duplicating its logic, since the two need to do exactly the same thing.
document.getElementById("gm-mobile-block-back").addEventListener("click", () => {
  document.getElementById("gm-map-back-btn").click();
});
