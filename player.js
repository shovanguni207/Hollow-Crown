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
const questToggle = document.getElementById("quest-toggle");
const questPanel = document.getElementById("quest-panel");
const questCount = document.getElementById("quest-count");
const questPanelList = document.getElementById("quest-panel-list");
const questJournal = document.getElementById("quest-journal");
const questJournalList = document.getElementById("quest-journal-list");
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

/* =========================================================
   QUEST TRACKING — live, not a static log. An objective is
   complete the moment any one of its conditions reads true,
   recomputed fresh on every render rather than cached:
     "manual"        — state.manualMarks, the reader's own tap,
                       the one piece of quest state that ISN'T
                       derived from anything else (see below).
     "reach-passage" — state.visitedNodes, a running set of
                       every passage reached this playthrough.
                       Deliberately NOT "is this the current
                       passage" — the reader has almost always
                       moved on by the time they check their
                       quest log, and "you visited the gatehouse"
                       shouldn't un-complete the moment you leave.
     "obtain-item"   — hasItem(), the same live inventory check
                       choices already use. This one DOES reverse
                       on "Go back" (inventory rolls back with
                       it) — consistent with how "Go back" already
                       un-grants items, rather than a second,
                       different notion of "permanently obtained."
   ========================================================= */
function isConditionMet(questId, obj, cond) {
  if (cond.type === "manual") return state.manualMarks.has(questId + ":" + obj.id);
  if (cond.type === "reach-passage") return state.visitedNodes.has(cond.target);
  if (cond.type === "obtain-item") return hasItem(cond.target);
  return false;
}

function isObjectiveComplete(questId, obj) {
  return (obj.conditions || []).some(cond => isConditionMet(questId, obj, cond));
}

function objectiveHasManualCondition(obj) {
  return (obj.conditions || []).some(c => c.type === "manual");
}

// Passage labels, looked up independently of grimoire-editor.js's
// passageTitle() — that's an authoring-side helper, and this file is
// meant to stand on its own for playing the built-in tale even without
// the Grimoire ever loading a custom one, same reasoning findItemLabel()
// above already follows for items rather than reusing an editor helper.
function findPassageLabel(id) {
  const node = activeStory.nodes[id];
  if (!node) return id;
  if (node.chapter && node.chapter.trim()) return node.chapter.trim();
  if (node.end && node.endingType) return node.endingType;
  return id;
}

// "Requires: reach Old Town or obtain Iron Key" — only the non-manual
// conditions get a hint; a manual condition has nothing to auto-detect,
// so there's nothing useful to tell the reader beyond the checkbox itself.
function objectiveHintText(obj) {
  const parts = (obj.conditions || [])
    .filter(c => c.type !== "manual")
    .map(c => c.type === "reach-passage" ? "reach " + findPassageLabel(c.target) : "obtain " + findItemLabel(c.target));
  return parts.length ? "Requires: " + parts.join(" or ") : "";
}

function toggleManualObjective(questId, obj) {
  const key = questId + ":" + obj.id;
  if (state.manualMarks.has(key)) state.manualMarks.delete(key);
  else state.manualMarks.add(key);
  updateQuestUI();
}

// Builds the quest/objective list into whichever container is passed in —
// called once for the header popover's list and once for the persistent
// journal's list (see updateQuestUI below), since they show identical
// content, just in two different presentations for different viewport
// widths. Rebuilt into each rather than shared/cloned so the manual-
// objective checkboxes in both copies stay independently wired.
function buildQuestListInto(container) {
  container.innerHTML = "";
  const quests = Object.values(activeStory.quests || {});

  quests.forEach(quest => {
    const objectives = quest.objectives || [];
    const questDone = objectives.length > 0 && objectives.every(o => isObjectiveComplete(quest.id, o));

    const questBlock = document.createElement("div");
    questBlock.className = "quest-tracker-quest";

    const title = document.createElement("p");
    title.className = "quest-tracker-quest-title";
    title.textContent = quest.title || "Untitled quest";
    if (questDone) {
      const badge = document.createElement("span");
      badge.className = "quest-tracker-complete-badge";
      badge.textContent = "Complete";
      title.appendChild(badge);
    }
    questBlock.appendChild(title);

    if (quest.description) {
      const desc = document.createElement("p");
      desc.className = "quest-tracker-quest-desc";
      desc.textContent = quest.description;
      questBlock.appendChild(desc);
    }

    const objList = document.createElement("ul");
    objList.className = "quest-tracker-objectives";

    objectives.forEach(obj => {
      const done = isObjectiveComplete(quest.id, obj);
      const manual = objectiveHasManualCondition(obj);

      const li = document.createElement("li");
      li.className = "quest-tracker-objective" + (done ? " done" : "");

      // Only a manual condition makes the checkbox an actual control —
      // a purely auto-tracked objective has nothing for the reader to
      // toggle, so it's a plain (non-interactive) status glyph instead.
      const check = document.createElement(manual ? "button" : "span");
      check.className = "quest-tracker-check";
      if (manual) {
        check.type = "button";
        check.setAttribute("aria-pressed", String(done));
        check.setAttribute("aria-label", (done ? "Mark incomplete: " : "Mark complete: ") + (obj.text || "objective"));
        check.addEventListener("click", () => toggleManualObjective(quest.id, obj));
      } else {
        check.setAttribute("aria-hidden", "true");
      }
      li.appendChild(check);

      const textWrap = document.createElement("div");
      textWrap.className = "quest-tracker-objective-text-wrap";
      const text = document.createElement("p");
      text.className = "quest-tracker-objective-text";
      text.textContent = obj.text || "";
      textWrap.appendChild(text);

      if (!done) {
        const hint = objectiveHintText(obj);
        if (hint) {
          const hintEl = document.createElement("p");
          hintEl.className = "quest-tracker-objective-hint";
          hintEl.textContent = hint;
          textWrap.appendChild(hintEl);
        }
      }
      li.appendChild(textWrap);
      objList.appendChild(li);
    });

    questBlock.appendChild(objList);
    container.appendChild(questBlock);
  });
}

// Recomputes the toggle (visible/hidden, active-quest count), the
// persistent journal's visibility, and both lists' contents. Called on
// every renderNode() — cheap, and the only way the counts stay honest as
// reaching a passage or picking up an item silently completes something —
// and again after every manual checkbox tap, since that changes
// completion without a passage change.
// Guarded: if the quest-tracker HTML isn't present for any reason (a
// mismatched file version, a page that hasn't picked up an index.html
// change yet), this silently does nothing instead of throwing — a top-
// level throw elsewhere in this file would have skipped every statement
// after it, including the "Begin the Tale"/"Leave the tale"/"Tell It
// Again" listeners further down, which is exactly the kind of failure
// that looks like "my stories vanished" when nothing was actually lost.
function updateQuestUI() {
  if (!questToggle || !questPanel || !questCount || !questPanelList) return;

  const quests = Object.values(activeStory.quests || {});
  const hasQuests = quests.length > 0;

  questToggle.hidden = !hasQuests;
  if (questJournal) questJournal.hidden = !hasQuests;
  if (!hasQuests) { questPanel.hidden = true; return; }

  const activeCount = quests.filter(q => {
    const objectives = q.objectives || [];
    return !(objectives.length > 0 && objectives.every(o => isObjectiveComplete(q.id, o)));
  }).length;
  questCount.textContent = String(activeCount);

  buildQuestListInto(questPanelList);
  if (questJournalList) buildQuestListInto(questJournalList);
}

if (questToggle && questPanel) {
  questToggle.addEventListener("click", () => {
    questPanel.hidden = !questPanel.hidden;
    questToggle.setAttribute("aria-expanded", String(!questPanel.hidden));
  });

  closeOnOutsideClick(questPanel, [questToggle], () => {
    questPanel.hidden = true;
    questToggle.setAttribute("aria-expanded", "false");
  });
}

function renderNode(nodeId) {
  const node = activeStory.nodes[nodeId];
  if (!node) {
    passageText.textContent = "This passage doesn't exist yet, the tale ends here by accident rather than design.";
    choicesEl.innerHTML = "";
    return;
  }

  state.currentNode = nodeId;
  state.visitedNodes.add(nodeId);

  if (node.end) {
    showEnding(node);
    return;
  }

  hideAllPages();
  storyPage.hidden = false;

  chapterLabel.textContent = node.chapter || "";
  passageText.textContent = node.text || "";
  renderInventory();
  updateQuestUI();
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

// The one place a fresh play session's state gets built — grimoire-editor.js's
// playtest button and grimoire-manager.js's playTaleFromLibrary both call
// this too, rather than each keeping their own copy of the object literal
// (three separate copies used to drift is exactly the kind of thing that
// silently goes stale when a field like visitedNodes gets added later).
function freshPlayState() {
  return {
    currentNode: "start",
    inventory: [],
    history: [],
    visitedNodes: new Set(["start"]),
    manualMarks: new Set()
  };
}

function resetState() {
  state = freshPlayState();
}

document.getElementById("start-btn").addEventListener("click", () => {
  mode = "play";
  activeStory = DEFAULT_STORY;
  resetState();
  renderNode("start");
});

// Where "Leave the tale" / "Tell It Again" send you back to depends on how
// you got into the story in the first place — the editor's own playtest,
// straight from the library (see playTaleFromLibrary in
// grimoire-manager.js — this is the mobile-friendly path, since the editor
// itself is desktop-only), or the title screen's built-in tale. One
// function so the two button handlers below can't drift out of sync on
// which mode goes where.
function backToStoryOrigin() {
  hideAllPages();
  if (mode === "gm-playtest") { gmMapPage.hidden = false; NodeGraph.render(); }
  else if (mode === "library-play") { managerPage.hidden = false; renderManager(); }
  else { titlePage.hidden = false; }
}

document.getElementById("leave-story-btn").addEventListener("click", backToStoryOrigin);

document.getElementById("restart-btn").addEventListener("click", () => {
  resetState();
  backToStoryOrigin();
});
