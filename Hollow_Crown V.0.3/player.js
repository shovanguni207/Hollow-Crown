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
const questJournalSearchInput = document.getElementById("quest-journal-search");
const questPanelSearchInput = document.getElementById("quest-panel-search");
const questJournalSearchWrap = document.getElementById("quest-journal-search-wrap");
const questPanelSearchWrap = document.getElementById("quest-panel-search-wrap");
const questJournalSearchToggle = document.getElementById("quest-journal-search-toggle");
const questPanelSearchToggle = document.getElementById("quest-panel-search-toggle");
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
   There used to be a third type, "manual" — the reader tapping a
   checkbox to self-report an objective done, with no underlying
   story state to verify it against. Removed along with the reader-
   facing checkbox that drove it (see buildQuestListInto below):
   every objective is now purely auto-tracked, so an unmatched
   cond.type (including a leftover "manual" from a tale authored
   before this removal) simply falls through to false below rather
   than needing a case of its own.
   ========================================================= */
function isConditionMet(questId, obj, cond) {
  if (cond.type === "reach-passage") return state.visitedNodes.has(cond.target);
  if (cond.type === "obtain-item") return hasItem(cond.target);
  return false;
}

function isObjectiveComplete(questId, obj) {
  return (obj.conditions || []).some(cond => isConditionMet(questId, obj, cond));
}

// Same OR-across-the-array logic as isObjectiveComplete, scoped to a
// quest's discoverConditions instead of one objective's conditions —
// empty means always discovered (today's behavior, and the default for
// every quest that doesn't opt into being hidden). Passed a bare cond
// with no questId/obj context since discovery isn't about an objective —
// harmless now that isConditionMet has no condition type left that
// reads those two arguments.
function isQuestDiscovered(quest) {
  const conditions = Array.isArray(quest.discoverConditions) ? quest.discoverConditions : [];
  if (conditions.length === 0) return true;
  return conditions.some(cond => isConditionMet(null, null, cond));
}

// Same check, scoped to one objective within an already-discovered quest
// — a quest can be visible in the journal while one of its objectives
// stays hidden a while longer. Doesn't affect isObjectiveComplete/quest
// completion at all: a hidden objective still has to be done for its
// quest to read "Complete," it just isn't rendered in the list until
// this returns true, same as an undiscovered quest still exists in the
// data the instant its discoverConditions are met.
function isObjectiveDiscovered(obj) {
  const conditions = Array.isArray(obj.discoverConditions) ? obj.discoverConditions : [];
  if (conditions.length === 0) return true;
  return conditions.some(cond => isConditionMet(null, null, cond));
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

// "Requires: reach Old Town or obtain Iron Key"
function objectiveHintText(obj) {
  const parts = (obj.conditions || [])
    .map(c => c.type === "reach-passage" ? "reach " + findPassageLabel(c.target) : "obtain " + findItemLabel(c.target));
  return parts.length ? "Requires: " + parts.join(" or ") : "";
}

// Which quests have their objectives collapsed in the journal — UI-only
// preference, not part of `state`/freshPlayState(), since it's about how
// the journal is displayed rather than anything about the playthrough
// itself. Keyed by quest.id.
let collapsedQuests = new Set();

// Tracks which quest ids were discovered as of the last updateQuestUI()
// call, purely so a newly-discovered quest can be toasted exactly once,
// on the render where it first appears — not every render after. Reset
// (see freshPlayState() below) at the start of every session so a fresh
// playthrough gets its own discovery toasts rather than inheriting the
// previous session's. questDiscoveryBaselineSet guards the very first
// call of a session: every quest with no discoverConditions is "already
// discovered" from the first frame, and that's the starting journal, not
// a discovery event worth announcing.
// Text typed into the journal's search box — module-level, not reset on
// every render (same treatment as collapsedQuests above), and not reset
// on a new session either, matching that same existing choice rather
// than introducing a different rule for a very similar piece of state.
let questSearchQuery = "";

// Whether the search box itself is expanded — shared across both
// presentations (like the query text above) rather than tracked
// separately per presentation, so switching viewport width mid-search
// doesn't show one open and the other collapsed.
let questSearchOpen = false;

let lastDiscoveredQuestIds = new Set();
let questDiscoveryBaselineSet = false;

// Builds the quest/objective list into whichever container is passed in —
// called once for the header popover's list and once for the persistent
// journal's list (see updateQuestUI below), since they show identical
// content, just in two different presentations for different viewport
// widths.
function buildQuestListInto(container) {
  container.innerHTML = "";
  const query = questSearchQuery.trim().toLowerCase();
  const quests = Object.values(activeStory.quests || {}).filter(isQuestDiscovered);

  // A quest is shown if the query is empty, matches its own title/
  // description, or matches any (discovered) objective's text — searching
  // is about finding a quest, not about the quest already knowing it
  // matched, so a hit buried in one objective still surfaces the whole
  // quest rather than nothing at all.
  function questTextMatches(quest) {
    return (quest.title || "").toLowerCase().includes(query) ||
      (quest.description || "").toLowerCase().includes(query);
  }
  function objectiveTextMatches(obj) {
    return (obj.text || "").toLowerCase().includes(query);
  }

  const visibleQuests = quests.filter(quest => {
    if (!query) return true;
    if (questTextMatches(quest)) return true;
    return (quest.objectives || []).some(objectiveTextMatches);
  });

  if (query && visibleQuests.length === 0) {
    const empty = document.createElement("p");
    empty.className = "quest-tracker-search-empty";
    empty.textContent = "No quests match \u201c" + questSearchQuery.trim() + "\u201d.";
    container.appendChild(empty);
    return;
  }

  visibleQuests.forEach(quest => {
    const objectives = quest.objectives || [];
    const questDone = objectives.length > 0 && objectives.every(o => isObjectiveComplete(quest.id, o));

    const questBlock = document.createElement("div");
    questBlock.className = "quest-tracker-quest";

    const collapsed = collapsedQuests.has(quest.id);

    const title = document.createElement("button");
    title.type = "button";
    title.className = "quest-tracker-quest-title";
    title.setAttribute("aria-expanded", String(!collapsed));

    const chevron = document.createElement("span");
    chevron.className = "quest-tracker-chevron" + (collapsed ? "" : " expanded");
    chevron.textContent = "\u25B8";
    chevron.setAttribute("aria-hidden", "true");
    title.appendChild(chevron);

    title.appendChild(document.createTextNode(quest.title || "Untitled quest"));

    if (questDone) {
      const badge = document.createElement("span");
      badge.className = "quest-tracker-complete-badge";
      badge.textContent = "Complete";
      title.appendChild(badge);
    }
    title.addEventListener("click", () => {
      if (collapsed) collapsedQuests.delete(quest.id);
      else collapsedQuests.add(quest.id);
      updateQuestUI();
    });
    questBlock.appendChild(title);

    if (collapsed) {
      container.appendChild(questBlock);
      return;
    }

    if (quest.description) {
      const desc = document.createElement("p");
      desc.className = "quest-tracker-quest-desc";
      desc.textContent = quest.description;
      questBlock.appendChild(desc);
    }

    const objList = document.createElement("ul");
    objList.className = "quest-tracker-objectives";

    objectives.filter(isObjectiveDiscovered)
      .filter(obj => !query || questTextMatches(quest) || objectiveTextMatches(obj))
      .forEach(obj => {
      const done = isObjectiveComplete(quest.id, obj);

      const li = document.createElement("li");
      li.className = "quest-tracker-objective" + (done ? " done" : "");

      // Every objective is auto-tracked now (reach-passage/obtain-item) —
      // there's no reader-facing toggle anymore, so this is always a
      // plain, non-interactive status glyph.
      const check = document.createElement("span");
      check.className = "quest-tracker-check";
      check.setAttribute("aria-hidden", "true");
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

// Typing in either search box updates the shared query, mirrors the text
// into the other box (so switching viewport width mid-search shows the
// same filter rather than a blank one), and re-renders both lists.
// updateQuestUI() only ever replaces the *list* containers' innerHTML —
// never these input elements themselves — so the box being typed into
// keeps its focus and cursor position across every keystroke.
function setQuestSearchQuery(value, sourceInput) {
  questSearchQuery = value;
  [questJournalSearchInput, questPanelSearchInput].forEach(input => {
    if (input && input !== sourceInput) input.value = value;
  });
  updateQuestUI();
}
if (questJournalSearchInput) {
  questJournalSearchInput.addEventListener("input", () =>
    setQuestSearchQuery(questJournalSearchInput.value, questJournalSearchInput));
}
if (questPanelSearchInput) {
  questPanelSearchInput.addEventListener("input", () =>
    setQuestSearchQuery(questPanelSearchInput.value, questPanelSearchInput));
}

// Opening focuses the now-visible input; closing clears the query too —
// leaving a stale filter active behind a collapsed box would silently
// hide quests with nothing on screen explaining why. Shared across both
// presentations (see questSearchOpen's comment above), so toggling
// either one moves both, same mirroring setQuestSearchQuery already does
// for the query text itself.
function setQuestSearchOpen(open, focusInput) {
  questSearchOpen = open;
  [
    [questJournalSearchWrap, questJournalSearchToggle, questJournalSearchInput],
    [questPanelSearchWrap, questPanelSearchToggle, questPanelSearchInput]
  ].forEach(([wrap, toggle, input]) => {
    if (!wrap || !toggle) return;
    wrap.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    if (input) input.tabIndex = open ? 0 : -1; // collapsed-to-zero-width but still in the DOM — keep it out of tab order while closed
  });
  if (!open) {
    setQuestSearchQuery("", null);
  } else if (focusInput) {
    focusInput.focus();
  }
}
if (questJournalSearchToggle) {
  questJournalSearchToggle.addEventListener("click", () =>
    setQuestSearchOpen(!questSearchOpen, questJournalSearchInput));
}
if (questPanelSearchToggle) {
  questPanelSearchToggle.addEventListener("click", () =>
    setQuestSearchOpen(!questSearchOpen, questPanelSearchInput));
}
setQuestSearchOpen(false); // initializes tabIndex to match the collapsed default the CSS already starts in

// Recomputes the toggle (visible/hidden, active-quest count), the
// persistent journal's visibility, and both lists' contents. Called on
// every renderNode() — cheap, and the only way the counts stay honest as
// reaching a passage or picking up an item silently completes something.
// Guarded: if the quest-tracker HTML isn't present for any reason (a
// mismatched file version, a page that hasn't picked up an index.html
// change yet), this silently does nothing instead of throwing — a top-
// level throw elsewhere in this file would have skipped every statement
// after it, including the "Begin the Tale"/"Leave the tale"/"Tell It
// Again" listeners further down, which is exactly the kind of failure
// that looks like "my stories vanished" when nothing was actually lost.
function updateQuestUI() {
  if (!questToggle || !questPanel || !questCount || !questPanelList) return;

  const quests = Object.values(activeStory.quests || {}).filter(isQuestDiscovered);
  const hasQuests = quests.length > 0;

  // Toast newly-discovered quests before the early return below, so a
  // quest becoming discoverable is announced even on the render that
  // also flips hasQuests from false to true (the reader's very first
  // hidden quest appearing).
  if (questDiscoveryBaselineSet) {
    const newlyDiscovered = quests.filter(q => !lastDiscoveredQuestIds.has(q.id));
    if (newlyDiscovered.length === 1) {
      showToast("Quest discovered: " + (newlyDiscovered[0].title || "Untitled quest"));
    } else if (newlyDiscovered.length > 1) {
      showToast("Quests discovered: " + newlyDiscovered.map(q => q.title || "Untitled quest").join(", "));
    }
  } else {
    questDiscoveryBaselineSet = true; // this frame is the starting journal, not a discovery event
  }
  lastDiscoveredQuestIds = new Set(quests.map(q => q.id));

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
  // Side effect, not state carried in the returned object: every entry
  // point into a new session goes through here, so it's the one place
  // that can reset the discovery-toast tracking above without needing a
  // matching reset call added to each of the three callers individually.
  questDiscoveryBaselineSet = false;
  lastDiscoveredQuestIds = new Set();

  return {
    currentNode: "start",
    inventory: [],
    history: [],
    visitedNodes: new Set(["start"])
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