/* =========================================================
   GRIMOIRE EDITOR — one passage at a time: the drawer form,
   the choice accordion, and everything that commits the open
   form back into gmStory (save, playtest, new/delete passage).
   Passage-to-passage navigation now happens on the map itself
   (graph.js) rather than through a text list here.
   ========================================================= */

// ---- DOM refs: the passage editor form (queried once here rather than
// re-fetched by id on every keystroke/save, same pattern as player.js's
// play-screen refs) ----
const gmNodeIdInput = document.getElementById("gm-node-id");
const gmNodeGroupInput = document.getElementById("gm-node-group");
const gmChapterInput = document.getElementById("gm-chapter");
const gmTextInput = document.getElementById("gm-text");
const gmIsEndingInput = document.getElementById("gm-is-ending");
const gmEndingTypeInput = document.getElementById("gm-ending-type");
const gmEndingFields = document.getElementById("gm-ending-fields");
const gmChoicesBlock = document.getElementById("gm-choices-block");
const gmDrawerTitle = document.getElementById("gm-drawer-title");

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

// Keeps the drawer's own header in sync with whatever's currently in the
// form (not necessarily what's saved — draft or not, the title should
// always reflect what's on screen). Reuses the same title logic the old
// sidebar list used, just fed from the live form fields instead of a
// stored node.
function updateDrawerTitle() {
  const { text, placeholder } = passageTitle({
    chapter: gmChapterInput.value,
    end: gmIsEndingInput.checked,
    endingType: gmEndingTypeInput.value
  });
  gmDrawerTitle.textContent = text;
  gmDrawerTitle.classList.toggle("placeholder", placeholder);
}
gmChapterInput.addEventListener("input", updateDrawerTitle);
gmEndingTypeInput.addEventListener("input", updateDrawerTitle);
gmIsEndingInput.addEventListener("change", updateDrawerTitle);

// Snapshots whatever's currently sitting in the passage form (saved or not)
// into nodeDrafts, under whichever node id is about to be navigated away
// from. Cloning editingChoices matters: it's the live array the choice
// cards write into, so storing the reference itself would let later edits
// to a *different* passage bleed backward into this draft.
function captureNodeDraft() {
  nodeDrafts[gmSelectedNodeId] = {
    chapter: gmChapterInput.value,
    text: gmTextInput.value,
    isEnding: gmIsEndingInput.checked,
    endingType: gmEndingTypeInput.value,
    choices: editingChoices.map(c => ({ ...c })),
    expandedChoiceIndex
  };
}

function selectGmNode(id) {
  if (gmEditorLoaded) captureNodeDraft();
  gmEditorLoaded = true;

  gmSelectedNodeId = id;
  const draft = nodeDrafts[id];
  const node = gmStory.nodes[id] || { chapter: "", text: "", choices: [] };

  gmNodeIdInput.value = id;
  updateGroupField();

  if (draft) {
    gmChapterInput.value = draft.chapter;
    gmTextInput.value = draft.text;
    gmIsEndingInput.checked = draft.isEnding;
    gmEndingTypeInput.value = draft.endingType;
    editingChoices = draft.choices.map(c => ({ ...c }));
    expandedChoiceIndex = draft.expandedChoiceIndex;
  } else {
    gmChapterInput.value = node.chapter || "";
    gmTextInput.value = node.text || "";
    gmIsEndingInput.checked = !!node.end;
    gmEndingTypeInput.value = node.endingType || "";
    editingChoices = (node.choices || []).map(c => ({
      label: c.label || "",
      to: c.to || "",
      requires: (c.requires && c.requires.item) || "",
      grantsItem: (c.grants && c.grants.item) || ""
    }));
    expandedChoiceIndex = null;
  }

  toggleEndingFields();
  renderChoiceRows();
  updateDrawerTitle();
}

function toggleEndingFields() {
  const isEnding = gmIsEndingInput.checked;
  gmEndingFields.hidden = !isEnding;
  gmChoicesBlock.hidden = isEnding;
}
gmIsEndingInput.addEventListener("change", toggleEndingFields);

/* ---- Renaming a passage's id -------------------------------------------
   Mirrors renameItemId (grimoire-items.js) for the same reason: an id is
   a reference key threaded through several places at once — every other
   passage's "leads to" choices, the map's saved layout position, and (if
   one happens to exist) a pending draft — so changing it can't be a plain
   text edit, it has to fan out to everywhere that reference lives.
   Returns how many choice references got updated, purely for the
   confirmation toast. */
function renameNodeId(oldId, newId) {
  gmStory.nodes[newId] = gmStory.nodes[oldId];
  delete gmStory.nodes[oldId];

  if (gmStory.layout && gmStory.layout[oldId]) {
    gmStory.layout[newId] = gmStory.layout[oldId];
    delete gmStory.layout[oldId];
  }

  let refCount = 0;
  Object.values(gmStory.nodes).forEach(node => {
    (node.choices || []).forEach(choice => {
      if (choice.to === oldId) {
        choice.to = newId;
        refCount++;
      }
    });
  });

  Object.values(nodeDrafts).forEach(draft => {
    (draft.choices || []).forEach(c => {
      if (c.to === oldId) { c.to = newId; refCount++; }
    });
  });
  if (nodeDrafts[oldId]) {
    nodeDrafts[newId] = nodeDrafts[oldId];
    delete nodeDrafts[oldId];
  }

  // Quest objectives can complete on "reach this passage" — same fan-out
  // problem items solve with renameItemId, one level removed. See
  // QuestEditor.renameConditionTargets (quest-editor.js).
  refCount += QuestEditor.renameConditionTargets("reach-passage", oldId, newId);

  if (gmSelectedNodeId === oldId) gmSelectedNodeId = newId;

  return refCount;
}

document.getElementById("gm-change-node-id-btn").addEventListener("click", async () => {
  const oldId = gmSelectedNodeId;
  if (oldId === "start") {
    await showAlert("The start passage's id can't be changed \u2014 the engine (and every playtest) looks for it by that exact id.");
    return;
  }

  const newId = await promptForNewId({
    subjectLabel: gmChapterInput.value.trim() || oldId,
    currentId: oldId,
    existingIds: Object.keys(gmStory.nodes)
  });
  if (!newId) return;

  const refCount = renameNodeId(oldId, newId);

  // Fix up the still-open form's own choices too, not just the stored
  // data — same as grimoire-items.js does for item ids — in case this
  // passage has a choice that loops back to itself.
  editingChoices.forEach(c => { if (c.to === oldId) c.to = newId; });

  touchCurrentTale();
  gmNodeIdInput.value = newId;
  renderChoiceRows();
  showToast("Passage id updated" + (refCount ? " \u2014 " + refCount + " reference" + (refCount === 1 ? "" : "s") + " fixed up." : "."));
});

/* ---- Group membership: read-only display + "Move to group" fallback ----
   Dragging a passage onto a group card on the map (graph.js) is the
   primary way to nest one — this is the fallback for when that's awkward
   (deeply nested, off-screen, or just faster to type). Unlike chapter/
   text/choices, groupId isn't part of the draft system: it's committed to
   gmStory immediately, same as "Change id" already does for passage and
   item ids, rather than waiting for an explicit Save. */
function updateGroupField() {
  const node = gmStory.nodes[gmSelectedNodeId];
  const groupId = node ? node.groupId : null;
  gmNodeGroupInput.value = groupId && gmStory.groups[groupId]
    ? NodeGraph.groupPathLabel(gmStory, groupId)
    : "\u2014 top level, no group \u2014";
}

document.getElementById("gm-change-node-group-btn").addEventListener("click", async () => {
  const id = gmSelectedNodeId;
  if (id === "start") {
    await showAlert("The start passage can't be moved into a group \u2014 it has to stay reachable at the top level for the map (and every playtest) to find it.");
    return;
  }

  const groupIds = Object.keys(gmStory.groups || {});
  if (groupIds.length === 0) {
    await showAlert("This tale has no groups yet \u2014 create one from the map's \u201c+ New group\u201d button first, then come back here to move this passage into it.");
    return;
  }

  const listing = groupIds.map(gid => gid + "  \u2014  " + NodeGraph.groupPathLabel(gmStory, gid)).join("\n");
  const raw = await showPrompt(
    "Group id to move this passage into (leave blank for the top level, no group):\n\n" + listing,
    gmStory.nodes[id].groupId || ""
  );
  if (raw === null) return;

  const trimmed = raw.trim();
  if (trimmed && !gmStory.groups[trimmed]) {
    await showAlert("No group with that id exists. Check the listing and try again.");
    return;
  }

  gmStory.nodes[id].groupId = trimmed || null;
  touchCurrentTale();
  updateGroupField();
  showToast(trimmed ? "Moved into \u201c" + gmStory.groups[trimmed].label + "\u201d." : "Moved to the top level.");
});

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
   name instead of retyping (and potentially mistyping) an id. Thin
   wrapper around the shared attachAutocomplete (ui-core.js) — this just
   supplies "match against item id/label" and "write the picked id back
   into this input." ---- */
function attachItemAutocomplete(field, input) {
  attachAutocomplete(
    field,
    input,
    (query) => {
      const ids = Object.keys((gmStory && gmStory.items) || {});
      const q = query.toLowerCase();
      return ids
        .filter(id => !q || id.toLowerCase().includes(q) || (gmStory.items[id].label || "").toLowerCase().includes(q))
        .slice(0, 8)
        .map(id => ({ id, label: gmStory.items[id].label || id }));
    },
    (id) => {
      input.value = id;
      input.dispatchEvent(new Event("input"));
    }
  );
}

document.getElementById("gm-add-choice").addEventListener("click", () => {
  editingChoices.push({ label: "", to: "", requires: "", grantsItem: "" });
  expandedChoiceIndex = editingChoices.length - 1; // open the new one straight away
  renderChoiceRows();
});

// ---- Delete passage -------------------------------
// (Creating a passage now happens only from the map's own "+ New passage" —
// see the "Map page: new passage" handler below — since the drawer no
// longer carries its own passage list to create one into.)
document.getElementById("gm-delete-node").addEventListener("click", async () => {
  if (gmSelectedNodeId === "start") {
    await showAlert("The start passage can't be deleted, every tale needs a beginning.");
    return;
  }
  const ok = await showConfirm("Delete this passage? Choices in other passages that lead here won't be fixed automatically.");
  if (!ok) return;
  delete gmStory.nodes[gmSelectedNodeId];
  delete nodeDrafts[gmSelectedNodeId];
  touchCurrentTale();
  selectGmNode("start");
  showToast("Passage deleted.");
});

// ---- Save passage -------------------------------
// Commits the currently-open passage form into gmStory. Shared by the
// explicit Save button and by closePassageDrawer() (grimoire-manager.js) —
// previously, leaving the editor only stashed changes into nodeDrafts (a
// same-session, never-persisted cache), so the map
// could silently show stale data with no indication anything was left
// unsaved. Committing on the way out closes that gap: the map now always
// reflects the same state the editor was just showing, and nothing
// depends on remembering to click Save.
function commitCurrentPassage() {
  if (!gmEditorLoaded) return;
  const id = gmSelectedNodeId;
  const isEnding = gmIsEndingInput.checked;
  const chapter = gmChapterInput.value.trim();
  const text = gmTextInput.value.trim();
  // groupId lives outside the draft system (set immediately by drag-to-nest
  // or "Move to group", not deferred to Save) — carry whatever's already on
  // the stored node forward, or this rebuild would silently drop it back to
  // ungrouped on every single save.
  const groupId = (gmStory.nodes[id] && gmStory.nodes[id].groupId) || null;

  if (isEnding) {
    gmStory.nodes[id] = {
      chapter,
      groupId,
      end: true,
      endingType: gmEndingTypeInput.value.trim() || "The End",
      text: text
    };
  } else {
    const choices = editingChoices
      .filter(c => c.label.trim() && c.to.trim())
      .map(c => {
        const out = { label: c.label.trim(), to: c.to.trim() };
        // resolveItemRef also mutates c.requires/c.grantsItem in place (both
        // reference the same objects living in editingChoices), so the field
        // shown in the still-open choice card updates to the clean id too.
        if (c.requires.trim()) {
          c.requires = resolveItemRef(c.requires);
          out.requires = { item: c.requires };
        }
        if (c.grantsItem.trim()) {
          c.grantsItem = resolveItemRef(c.grantsItem);
          out.grants = { item: c.grantsItem };
        }
        return out;
      });
    gmStory.nodes[id] = { chapter, groupId, text, choices };
  }

  touchCurrentTale();
  delete nodeDrafts[id]; // now identical to the saved node, so let selectGmNode fall back to gmStory again
}

document.getElementById("gm-save-node").addEventListener("click", () => {
  commitCurrentPassage();
  updateDrawerTitle();
  renderChoiceRows();
  renderItemDefs();
  showToast("Passage saved.");
});

// ---- Playtest -------------------------------
// (The drawer no longer has its own "Playtest from Start" — the map's
// button below is the only entry point now. The map's toolbar is behind
// the drawer's backdrop while a passage is open, so there's never a case
// where this fires with unsaved draft changes left uncommitted.)
document.getElementById("gm-map-playtest-btn").addEventListener("click", async () => {
  if (!gmStory.nodes.start) {
    await showAlert("Your tale needs a passage with the id 'start' before you can playtest it.");
    return;
  }
  mode = "gm-playtest";
  activeStory = gmStory;
  state = freshPlayState();
  renderNode("start");
});

// ---- Map page: new passage -------------------------------
document.getElementById("gm-map-new-node").addEventListener("click", async () => {
  const raw = await showPrompt("Id for the new passage (letters and numbers only, e.g. 'throneRoom'):");
  if (raw === null || !raw.trim()) return;
  const id = slugify(raw) || ("passage" + Date.now());
  if (gmStory.nodes[id]) {
    showToast("A passage with that id already exists — opening it.");
    enterPassageEditor(id);
    return;
  }
  gmStory.nodes[id] = { chapter: "", groupId: NodeGraph.currentContainer(), text: "", choices: [] };
  NodeGraph.placeNewNode(id); // drops it at the current center of the visible viewport
  touchCurrentTale();
  NodeGraph.render();
});