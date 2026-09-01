/* =========================================================
   PLAYER ENGINE — story playback, shared by the built-in
   tale and any Grimoire tale being read or playtested.
   renderNode()/showEnding() are generic: they read from
   whatever activeStory is currently set (see app-state.js),
   so this same engine plays both the default tale and any
   custom tale opened from the Grimoire.
   ========================================================= */

// ---- DOM refs: play/ending screens -------------------------------------
const chapterLabel = document.getElementById("chapter-label");
const backBtn = document.getElementById("back-btn");
const satchelToggle = document.getElementById("satchel-toggle");
const satchelPanel = document.getElementById("satchel-panel");
const satchelCount = document.getElementById("satchel-count");
const satchelList = document.getElementById("satchel-list");
const passageText = document.getElementById("passage-text");
const choicesEl = document.getElementById("choices");

const endingEyebrow = document.getElementById("ending-eyebrow");
const endingTitle = document.getElementById("ending-title");
const endingText = document.getElementById("ending-text");

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

  if (count === 0) satchelPanel.hidden = true}

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

  if (node.end) {
    showEnding(node);
    return;
  }

  hideAllPages();
  storyPage.hidden = false;

  chapterLabel.textContent = node.chapter || "";
  passageText.textContent = node.text || "";
  renderInventory();
  updateNavButtons();

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
      // Stash where we're leaving from so "Go back" can return to it.
      state.history.push({ currentNode: state.currentNode, inventory: state.inventory.slice() });
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

// Steps exactly one passage backward, restoring the inventory as it was at
// that point too (so undoing a choice that granted an item actually takes
// the item back, rather than just changing which passage is showing).
function goBack() {
  if (!state.history.length) return;
  const prev = state.history.pop();
  state.inventory = prev.inventory;
  renderNode(prev.currentNode);
}

function updateNavButtons() {
  backBtn.hidden = state.history.length === 0;
}

backBtn.addEventListener("click", goBack);

function resetState() {
  state = { currentNode: "start", inventory: [], history: [] };
}

document.getElementById("start-btn").addEventListener("click", () => {
  mode = "play";
  activeStory = DEFAULT_STORY;
  resetState();
  renderNode("start");
});

document.getElementById("leave-story-btn").addEventListener("click", () => {
  hideAllPages();
  if (mode === "gm-playtest") { gmMapPage.hidden = false; NodeGraph.render(); } else { titlePage.hidden = false; }
});

document.getElementById("restart-btn").addEventListener("click", () => {
  resetState();
  hideAllPages();
  if (mode === "gm-playtest") { gmMapPage.hidden = false; NodeGraph.render(); } else { titlePage.hidden = false; }
});
