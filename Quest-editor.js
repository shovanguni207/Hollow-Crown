/* =========================================================
   QuestEditor — objective/quest tracking for a tale, layered
   on top of the same passage graph and item registry the
   Grimoire already maintains (gmStory.nodes / gmStory.items).

   DATA SHAPE: gmStory.quests[id] = { id, title, description,
   tags: [], notes: "", objectives: [{ id, text, tags: [],
   notes: "", conditions: [{type, target}] }] }. Objectives are
   a plain ordered list, not a graph — unlike passages, nothing
   navigates a quest, so there's no reader choosing a path
   through it. The branching a quest actually needs (an
   objective closing out however the reader gets there —
   "defeat the captain OR bribe him") lives *within* one
   objective as multiple OR'd conditions, not as edges between
   objectives. That keeps the editor a card list (same register
   as the item ledger) instead of a second wire-graph.

   A condition's `type` is one of:
     "manual"        — no target, no auto-detection; the author
                       just wants to describe a beat. This is the
                       only type that actually does anything at
                       playtest time today.
     "reach-passage" — target is a passage id.
     "obtain-item"   — target is an item id.
   The latter two are fully authorable now (typed, validated,
   autocompleted against real ids) but nothing evaluates them
   during play yet — that's runtime work for later, once
   there's a clearer shape for the scripting layer they'll
   probably hook through. Writing them now, unevaluated, means
   a real quest can already be fully described; wiring
   auto-completion later is additive, not a rewrite.

   Kept in its own file (see the original stub's reasoning):
   this is a self-contained subsystem with its own data model
   and card-list UI, and folding it into grimoire-manager.js or
   grimoire-editor.js would tangle unrelated diffs together.

   THE INSPECTOR (right-hand panel, Quests view only for now):
   shows whichever quest or objective was last clicked, with a
   live "References" list — every passage/item that thing's
   conditions point at, deduplicated, each clickable to jump
   straight there (Graph view, passage drawer open, or the item
   ledger's card expanded). This is the same cross-reference
   information renameNodeId/renameItemId already have to keep in
   sync behind the scenes (see renameConditionTargets below) —
   the Inspector just makes it visible to the author too, instead
   of it only mattering at rename-time. Selection state lives in
   gmInspectorSelection (app-state.js); it's cleared whenever the
   thing it points at is deleted, so it can never go stale.
   ========================================================= */

const QuestEditor = (function () {

  const CONDITION_TYPES = [
    { type: "manual",        label: "Manual (mark it yourself)" },
    { type: "reach-passage", label: "Reach a passage" },
    { type: "obtain-item",   label: "Obtain an item" }
  ];

  function ensureQuestsObj() {
    if (!gmStory.quests) gmStory.quests = {};
  }

  // Defensive defaults for tags/notes — added after quests already shipped,
  // so anything created before this point won't have them. Called on
  // creation (belt) and again wherever a quest/objective is read for the
  // Inspector (suspenders), so a tale saved before this feature existed
  // never hits a missing-field error, it just quietly gains empty tags/notes.
  function ensureQuestMeta(quest) {
    if (!quest.tags) quest.tags = [];
    if (quest.notes === undefined) quest.notes = "";
  }
  function ensureObjectiveMeta(obj) {
    if (!obj.tags) obj.tags = [];
    if (obj.notes === undefined) obj.notes = "";
  }

  function uniqueQuestId(title) {
    const base = slugify(title) || "quest";
    let id = base, n = 2;
    while (gmStory.quests[id]) { id = base + "-" + n; n++; }
    return id;
  }

  function uniqueObjectiveId(quest) {
    let n = quest.objectives.length + 1;
    let id = "obj" + n;
    while (quest.objectives.some(o => o.id === id)) { n++; id = "obj" + n; }
    return id;
  }

  /* ---- Rename fan-out ---------------------------------------------------
     Called from renameNodeId (grimoire-editor.js) and renameItemId
     (grimoire-items.js) — same problem those two already solve for
     choices, one level removed: a quest condition can reference a passage
     or item by id, so that id can't just be a plain string once something
     else might rename it out from under the reference. conditionType is
     "reach-passage" or "obtain-item"; returns how many condition targets
     got updated, for the same "N references fixed up" toast the other two
     renames already show. Safe to call even before this file's own render()
     has ever run — it only touches gmStory.quests, never DOM. */
  function renameConditionTargets(conditionType, oldId, newId) {
    ensureQuestsObj();
    let refCount = 0;
    Object.values(gmStory.quests).forEach(quest => {
      (quest.objectives || []).forEach(obj => {
        (obj.conditions || []).forEach(cond => {
          if (cond.type === conditionType && cond.target === oldId) {
            cond.target = newId;
            refCount++;
          }
        });
      });
    });
    return refCount;
  }

  /* ---- Quest lifecycle ---------------------------------------------- */
  async function createQuest() {
    ensureQuestsObj();
    const title = await showPrompt("Name this quest:", "Untitled quest");
    if (title === null) return;
    const id = uniqueQuestId(title || "quest");
    gmStory.quests[id] = {
      id,
      title: title.trim() || "Untitled quest",
      description: "",
      tags: [],
      notes: "",
      objectives: []
    };
    expandedQuestId = id;
    gmInspectorSelection = { kind: "quest", id };
    touchCurrentTale();
  }

  async function deleteQuest(quest) {
    const ok = await showConfirm("Delete the quest \u201c" + (quest.title || quest.id) + "\u201d? This can't be undone.");
    if (!ok) return;
    delete gmStory.quests[quest.id];
    if (expandedQuestId === quest.id) expandedQuestId = null;
    // A reference the Inspector is currently showing just vanished under
    // it — clear the selection rather than let it point at a deleted
    // quest/objective (see renderInspector's own defensive re-check too,
    // this just avoids a flash of the stale panel before that catches it).
    if (gmInspectorSelection && (
      (gmInspectorSelection.kind === "quest" && gmInspectorSelection.id === quest.id) ||
      (gmInspectorSelection.kind === "objective" && gmInspectorSelection.questId === quest.id)
    )) {
      gmInspectorSelection = null;
    }
    touchCurrentTale();
  }

  function addObjective(quest) {
    const id = uniqueObjectiveId(quest);
    quest.objectives.push({ id, text: "", tags: [], notes: "", conditions: [{ type: "manual" }] });
    touchCurrentTale();
  }

  function removeObjective(quest, index) {
    const removedId = quest.objectives[index].id;
    quest.objectives.splice(index, 1);
    if (gmInspectorSelection && gmInspectorSelection.kind === "objective" &&
        gmInspectorSelection.questId === quest.id && gmInspectorSelection.objectiveId === removedId) {
      gmInspectorSelection = null;
    }
    touchCurrentTale();
  }

  function addCondition(objective) {
    objective.conditions.push({ type: "manual" });
    touchCurrentTale();
  }

  function removeCondition(objective, index) {
    if (objective.conditions.length <= 1) return; // always leave at least one way to complete
    objective.conditions.splice(index, 1);
    touchCurrentTale();
  }

  /* ---- Rendering ------------------------------------------------------ */
  function render() {
    ensureQuestsObj();
    const wrap = document.getElementById("quest-list");
    if (!wrap) return; // guard: called before the Quests tab has ever mounted
    wrap.innerHTML = "";

    const ids = Object.keys(gmStory.quests);
    if (ids.length === 0) {
      const empty = document.createElement("p");
      empty.className = "ledger-empty";
      empty.textContent = "No quests yet — add one with \u201c+ New quest\u201d above, then give it a few objectives to track.";
      wrap.appendChild(empty);
      renderInspector();
      return;
    }

    ids.forEach(id => wrap.appendChild(buildQuestCard(gmStory.quests[id])));
    renderInspector();
  }

  function questSummaryText(quest) {
    const count = quest.objectives.length;
    return (quest.title || "Untitled quest") + "  \u2014  " + count + " objective" + (count === 1 ? "" : "s");
  }

  function buildQuestCard(quest) {
    const isExpanded = expandedQuestId === quest.id;
    const isSelected = gmInspectorSelection && gmInspectorSelection.kind === "quest" && gmInspectorSelection.id === quest.id;

    const card = buildAccordionCard({
      isExpanded,
      onToggle: () => {
        expandedQuestId = isExpanded ? null : quest.id;
        gmInspectorSelection = { kind: "quest", id: quest.id }; // clicking a quest's header always makes it the Inspector's subject, whether this expands or collapses it
        render();
      },
      removeLabel: "Delete",
      onRemove: () => deleteQuest(quest),
      buildSummary: (summary) => {
        const mark = document.createElement("span");
        mark.className = "item-mark";
        mark.textContent = "\u2726";
        mark.setAttribute("aria-hidden", "true");
        summary.appendChild(mark);
        summary.appendChild(document.createTextNode(questSummaryText(quest)));
      },
      buildBody: (body) => {
        const titleField = document.createElement("label");
        titleField.className = "gm-choice-field quest-card-title-field";
        titleField.textContent = "Title";
        const titleInput = document.createElement("input");
        titleInput.type = "text";
        titleInput.value = quest.title;
        titleInput.addEventListener("change", () => {
          quest.title = titleInput.value.trim() || quest.id;
          touchCurrentTale();
        });
        titleField.appendChild(titleInput);
        body.appendChild(titleField);

        const descField = document.createElement("label");
        descField.className = "gm-choice-field";
        descField.textContent = "Description (optional)";
        const descInput = document.createElement("input");
        descInput.type = "text";
        descInput.value = quest.description || "";
        descInput.addEventListener("change", () => {
          quest.description = descInput.value.trim();
          touchCurrentTale();
        });
        descField.appendChild(descInput);
        body.appendChild(descField);

        const objectivesBlock = document.createElement("div");
        objectivesBlock.className = "quest-objectives-block";

        const objHead = document.createElement("p");
        objHead.className = "gm-subhead";
        objHead.textContent = "Objectives";
        objectivesBlock.appendChild(objHead);

        if (quest.objectives.length === 0) {
          const empty = document.createElement("p");
          empty.className = "hint";
          empty.style.textAlign = "left";
          empty.textContent = "No objectives yet, add one below.";
          objectivesBlock.appendChild(empty);
        }

        quest.objectives.forEach((obj, i) => {
          objectivesBlock.appendChild(buildObjectiveBlock(quest, obj, i));
        });

        const addObjBtn = document.createElement("button");
        addObjBtn.type = "button";
        addObjBtn.className = "btn-small";
        addObjBtn.textContent = "+ Add objective";
        addObjBtn.addEventListener("click", () => addObjective(quest));
        objectivesBlock.appendChild(addObjBtn);

        body.appendChild(objectivesBlock);
      }
    });

    if (isSelected) card.classList.add("inspector-selected");
    return card;
  }

  function buildObjectiveBlock(quest, obj, index) {
    const block = document.createElement("div");
    const isSelected = gmInspectorSelection && gmInspectorSelection.kind === "objective" &&
      gmInspectorSelection.questId === quest.id && gmInspectorSelection.objectiveId === obj.id;
    block.className = "quest-objective" + (isSelected ? " inspector-selected" : "");

    const row = document.createElement("div");
    row.className = "quest-objective-row";

    const numTag = document.createElement("button");
    numTag.type = "button";
    numTag.className = "quest-objective-num-btn";
    numTag.title = "Inspect this objective";
    numTag.textContent = (index + 1) + ".";
    numTag.addEventListener("click", () => {
      gmInspectorSelection = { kind: "objective", questId: quest.id, objectiveId: obj.id };
      render();
    });
    row.appendChild(numTag);

    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.placeholder = "What does the reader need to do?";
    textInput.value = obj.text;
    textInput.addEventListener("change", () => {
      obj.text = textInput.value.trim();
      touchCurrentTale();
    });
    row.appendChild(textInput);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "gm-remove-choice";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeObjective(quest, index));
    row.appendChild(removeBtn);

    block.appendChild(row);

    const completesLabel = document.createElement("p");
    completesLabel.className = "hint-inline";
    completesLabel.style.marginTop = "10px";
    completesLabel.textContent = "Completes when any one of these is true:";
    block.appendChild(completesLabel);

    obj.conditions.forEach((cond, ci) => {
      if (ci > 0) {
        const orTag = document.createElement("p");
        orTag.className = "quest-condition-or";
        orTag.textContent = "or";
        block.appendChild(orTag);
      }
      block.appendChild(buildConditionRow(obj, cond, ci));
    });

    const addCondBtn = document.createElement("button");
    addCondBtn.type = "button";
    addCondBtn.className = "btn-tiny";
    addCondBtn.style.marginTop = "8px";
    addCondBtn.textContent = "+ Add another way to complete this";
    addCondBtn.addEventListener("click", () => addCondition(obj));
    block.appendChild(addCondBtn);

    return block;
  }

  function buildConditionRow(obj, cond, index) {
    const row = document.createElement("div");
    row.className = "quest-condition-row";

    const typeField = document.createElement("label");
    typeField.className = "gm-choice-field quest-condition-type-field";
    typeField.textContent = "Condition";
    const select = document.createElement("select");
    CONDITION_TYPES.forEach(opt => {
      const optionEl = document.createElement("option");
      optionEl.value = opt.type;
      optionEl.textContent = opt.label;
      if (cond.type === opt.type) optionEl.selected = true;
      select.appendChild(optionEl);
    });
    select.addEventListener("change", () => {
      cond.type = select.value;
      if (cond.type === "manual") delete cond.target; else cond.target = cond.target || "";
      touchCurrentTale();
    });
    typeField.appendChild(select);
    row.appendChild(typeField);

    if (cond.type !== "manual") {
      const targetField = document.createElement("label");
      targetField.className = "gm-choice-field quest-condition-target-field";
      targetField.textContent = cond.type === "reach-passage" ? "Passage id" : "Item id";

      const targetInput = document.createElement("input");
      targetInput.type = "text";
      targetInput.autocomplete = "off";
      targetInput.value = cond.target || "";
      targetInput.addEventListener("input", () => {
        cond.target = targetInput.value.trim();
      });
      targetInput.addEventListener("change", () => {
        touchCurrentTale();
      });
      targetField.appendChild(targetInput);

      if (cond.type === "reach-passage") {
        attachAutocomplete(
          targetField,
          targetInput,
          (query) => {
            const ids = Object.keys(gmStory.nodes || {});
            const q = query.toLowerCase();
            return ids
              .filter(id => !q || id.toLowerCase().includes(q) || (gmStory.nodes[id].chapter || "").toLowerCase().includes(q))
              .slice(0, 8)
              .map(id => ({ id, label: passageTitle(gmStory.nodes[id]).text }));
          },
          (id) => {
            targetInput.value = id;
            cond.target = id;
            touchCurrentTale();
          }
        );
      } else {
        attachAutocomplete(
          targetField,
          targetInput,
          (query) => {
            const ids = Object.keys(gmStory.items || {});
            const q = query.toLowerCase();
            return ids
              .filter(id => !q || id.toLowerCase().includes(q) || (gmStory.items[id].label || "").toLowerCase().includes(q))
              .slice(0, 8)
              .map(id => ({ id, label: gmStory.items[id].label || id }));
          },
          (id) => {
            targetInput.value = id;
            cond.target = id;
            touchCurrentTale();
          }
        );
      }

      row.appendChild(targetField);
    }

    if (obj.conditions.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "gm-remove-choice";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => removeCondition(obj, index));
      row.appendChild(removeBtn);
    }

    return row;
  }

  /* ---- Inspector -------------------------------------------------------
     See the header comment for the concept. Everything below reads
     gmInspectorSelection (app-state.js) and rebuilds #quest-inspector-body
     from scratch — same "just rebuild it" approach as render() above,
     rather than a partial-update scheme, for the same reason: this is a
     small, infrequently-changing panel, and one consistent rendering
     strategy across the whole file is worth more than shaving redraws. */

  // Same target, referenced twice (once from a manual-only condition that
  // got switched to reach-passage/obtain-item without a value yet, once
  // from an actual duplicate) collapse to one row — the point of this
  // list is "what does this depend on," not "how many times."
  function dedupeRefs(conditions) {
    const seen = new Set();
    const out = [];
    (conditions || []).forEach(cond => {
      if (cond.type === "manual" || !cond.target) return;
      const key = cond.type + ":" + cond.target;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(cond);
    });
    return out;
  }

  function refDisplayLabel(cond) {
    if (cond.type === "reach-passage") {
      const node = gmStory.nodes[cond.target];
      return node ? passageTitle(node).text : (cond.target + " (missing)");
    }
    const def = gmStory.items[cond.target];
    return def ? (def.label || cond.target) : (cond.target + " (missing)");
  }

  // "Clickable, jumps to the reference" — a passage reference opens the
  // Graph view with that passage's drawer open; an item reference does the
  // same but for whichever passage is already open (items aren't attached
  // to any one passage — the ledger inside the drawer is where every item
  // lives regardless of which passage you're looking at), with that one
  // item's card expanded so it's immediately visible, not just scrolled to.
  function jumpToReference(cond) {
    if (!cond.target) return;
    if (cond.type === "reach-passage") {
      setGmView("graph");
      enterPassageEditor(cond.target);
    } else if (cond.type === "obtain-item") {
      setGmView("graph");
      enterPassageEditor(gmSelectedNodeId || "start");
      expandedItemId = cond.target;
      renderItemDefs();
    }
  }

  function buildReferenceList(refs) {
    const wrap = document.createElement("div");
    wrap.className = "quest-inspector-refs";

    if (refs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "quest-inspector-ref-empty";
      empty.textContent = "No passage or item references yet.";
      wrap.appendChild(empty);
      return wrap;
    }

    refs.forEach(cond => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quest-inspector-ref-btn";

      const kindTag = document.createElement("span");
      kindTag.className = "quest-inspector-ref-kind";
      kindTag.textContent = cond.type === "reach-passage" ? "Passage" : "Item";
      btn.appendChild(kindTag);
      btn.appendChild(document.createTextNode(refDisplayLabel(cond)));

      btn.addEventListener("click", () => jumpToReference(cond));
      wrap.appendChild(btn);
    });

    return wrap;
  }

  function buildTagsEditor(entity) {
    const wrap = document.createElement("div");

    const chipRow = document.createElement("div");
    chipRow.className = "quest-inspector-tags";
    entity.tags.forEach((tag, i) => {
      const chip = document.createElement("span");
      chip.className = "quest-inspector-tag";
      chip.appendChild(document.createTextNode(tag));

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "\u00d7";
      removeBtn.setAttribute("aria-label", "Remove tag " + tag);
      removeBtn.addEventListener("click", () => {
        entity.tags.splice(i, 1);
        touchCurrentTale(); // re-renders this whole panel while Quests is active — see the file header note on this pattern
      });
      chip.appendChild(removeBtn);
      chipRow.appendChild(chip);
    });
    wrap.appendChild(chipRow);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "quest-inspector-tag-input";
    input.placeholder = "Add a tag\u2026";
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const val = input.value.trim();
      if (!val) return;
      if (entity.tags.some(t => t.toLowerCase() === val.toLowerCase())) return;
      entity.tags.push(val);
      touchCurrentTale();
    });
    wrap.appendChild(input);

    return wrap;
  }

  function buildNotesEditor(entity, kindLabel) {
    const textarea = document.createElement("textarea");
    textarea.className = "quest-inspector-notes";
    textarea.placeholder = "Notes about this " + kindLabel + "\u2026";
    textarea.value = entity.notes;
    textarea.addEventListener("change", () => {
      entity.notes = textarea.value;
      touchCurrentTale();
    });
    return textarea;
  }

  function appendSectionTitle(body, text) {
    const el = document.createElement("p");
    el.className = "quest-inspector-section-title";
    el.textContent = text;
    body.appendChild(el);
  }

  function buildQuestInspector(body, quest) {
    ensureQuestMeta(quest);

    const kind = document.createElement("p");
    kind.className = "quest-inspector-kind";
    kind.textContent = "Quest";
    body.appendChild(kind);

    const title = document.createElement("p");
    title.className = "quest-inspector-title";
    title.textContent = quest.title || "Untitled quest";
    body.appendChild(title);

    const meta = document.createElement("p");
    meta.className = "quest-inspector-meta";
    meta.textContent = quest.objectives.length + " objective" + (quest.objectives.length === 1 ? "" : "s");
    body.appendChild(meta);

    appendSectionTitle(body, "References");
    body.appendChild(buildReferenceList(dedupeRefs(quest.objectives.flatMap(o => o.conditions || []))));

    appendSectionTitle(body, "Tags");
    body.appendChild(buildTagsEditor(quest));

    appendSectionTitle(body, "Notes");
    body.appendChild(buildNotesEditor(quest, "quest"));
  }

  function buildObjectiveInspector(body, quest, obj) {
    ensureObjectiveMeta(obj);

    const kind = document.createElement("p");
    kind.className = "quest-inspector-kind";
    kind.textContent = "Objective";
    body.appendChild(kind);

    const title = document.createElement("p");
    title.className = "quest-inspector-title";
    title.textContent = obj.text || "(untitled objective)";
    body.appendChild(title);

    const meta = document.createElement("p");
    meta.className = "quest-inspector-meta";
    meta.appendChild(document.createTextNode("Belongs to "));
    const link = document.createElement("button");
    link.type = "button";
    link.className = "quest-inspector-parent-link";
    link.textContent = quest.title || "Untitled quest";
    link.addEventListener("click", () => {
      expandedQuestId = quest.id;
      gmInspectorSelection = { kind: "quest", id: quest.id };
      render();
    });
    meta.appendChild(link);
    body.appendChild(meta);

    appendSectionTitle(body, "References");
    body.appendChild(buildReferenceList(dedupeRefs(obj.conditions)));

    appendSectionTitle(body, "Tags");
    body.appendChild(buildTagsEditor(obj));

    appendSectionTitle(body, "Notes");
    body.appendChild(buildNotesEditor(obj, "objective"));
  }

  function renderInspector() {
    const body = document.getElementById("quest-inspector-body");
    if (!body) return; // guard: called before the Quests tab has ever mounted
    body.innerHTML = "";

    if (!gmInspectorSelection) {
      const empty = document.createElement("p");
      empty.className = "quest-inspector-empty";
      empty.textContent = "Select a quest or an objective to inspect it here \u2014 you'll see everything it references, and can tag or annotate it.";
      body.appendChild(empty);
      return;
    }

    if (gmInspectorSelection.kind === "quest") {
      const quest = gmStory.quests[gmInspectorSelection.id];
      if (!quest) { gmInspectorSelection = null; renderInspector(); return; } // pointed at something that's since been deleted
      buildQuestInspector(body, quest);
    } else {
      const quest = gmStory.quests[gmInspectorSelection.questId];
      const obj = quest && quest.objectives.find(o => o.id === gmInspectorSelection.objectiveId);
      if (!quest || !obj) { gmInspectorSelection = null; renderInspector(); return; }
      buildObjectiveInspector(body, quest, obj);
    }
  }

  document.getElementById("gm-quest-new-btn").addEventListener("click", createQuest);

  return { render, renameConditionTargets };
})();