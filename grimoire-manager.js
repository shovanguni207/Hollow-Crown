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

/* ---- Opening / leaving one tale ------------------------------- */
// Opening a tale now lands on the map (NodeGraph.render(), in graph.js)
// rather than jumping straight into a passage form — the map is the new
// entry point, and the passage editor is one node-click away from it.
function openTale(id) {
  currentTaleId = id;
  gmStory = tales[id].story;
  expandedItemId = null;
  nodeDrafts = {};
  gmEditorLoaded = false;
  hideAllPages();
  gmMapPage.hidden = false;
  updateGmTaleBar();
  renderItemDefs();
  NodeGraph.render({ resetView: true });
}

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
}

document.getElementById("gm-map-export-btn").addEventListener("click", () => exportTale(currentTaleId));

document.getElementById("gm-map-rename-tale-btn").addEventListener("click", () => renameTale(currentTaleId));

document.getElementById("gm-map-back-btn").addEventListener("click", () => {
  nodeDrafts = {}; // leaving the tale entirely: any unsaved passage edits are discarded here, by design
  hideAllPages();
  managerPage.hidden = false;
  renderManager();
});