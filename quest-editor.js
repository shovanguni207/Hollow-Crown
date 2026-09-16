/* =========================================================
   QuestEditor — objective/quest tracking for a tale, layered
   on top of the same passage graph and item registry the
   Grimoire already maintains (gmStory.nodes / gmStory.items).

   DATA SHAPE: gmStory.quests[id] = { id, title, description,
   tags: [], notes: "", discoverConditions: [{type, target}],
   objectives: [{ id, text, tags: [], notes: "",
   discoverConditions: [{type, target}], conditions: [{type, target}] }] }.

   discoverConditions gates visibility, at two levels: on a quest it
   gates whether the quest appears in the journal at all; on an
   objective it gates whether that one objective appears in an
   already-visible quest's list (a quest can be discovered while some
   of its objectives stay hidden a while longer — a progressive reveal
   within a quest the reader already knows about). Same {type, target}
   shape and same OR-across-the-array semantics both times, since it's
   the exact same condition machinery as an objective's *completion*
   conditions, just answering "is this visible" instead of "is this
   done." Empty (the default at both levels) means always visible,
   which is today's behavior, so no migration was needed to add this.
   buildDiscoveryConditionsUI renders both levels; the objective-level
   call passes { showHeading: false } to collapse to just the toggle
   button when empty, since an objective card is already denser than a
   quest card and doesn't have room for a labeled subsection plus a
   default-state hint on every single objective.

   addCondition/removeCondition/buildConditionRow all take a bare
   conditions array (not "an objective" or "a quest") specifically so
   this one condition-editing UI serves objective completion, quest
   discovery, AND objective discovery without a fourth copy of it — and
   so the next thing that wants a conditions array (a failure state, a
   prerequisite quest) can reuse it the same way rather than a fifth.
   Objectives are
   a plain ordered list, not a graph — unlike passages, nothing
   navigates a quest, so there's no reader choosing a path
   through it. The branching a quest actually needs (an
   objective closing out however the reader gets there —
   "defeat the captain OR bribe him") lives *within* one
   objective as multiple OR'd conditions, not as edges between
   objectives. That keeps the editor a card list (same register
   as the item ledger) instead of a second wire-graph.

   A condition's `type` is one of:
     "reach-passage" — target is a passage id.
     "obtain-item"   — target is an item id.
   Both are typed, validated, and autocompleted against real ids, and
   both are evaluated live at playtest/read time (player.js's
   isConditionMet). There used to be a third type, "manual" — the
   reader self-reporting a beat done via a checkbox, with nothing to
   verify it against — removed along with that checkbox once the other
   two types made it unnecessary. A tale authored before the removal
   may still have a stray {type:"manual"} sitting in its data; nothing
   here or in player.js crashes on it, it just never completes or
   discovers (see isConditionMet's comment in player.js).

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

  // "manual" used to be a third entry here (a no-target, no-auto-detect
  // condition the reader checked off by hand). Removed along with the
  // reader-facing checkbox that drove it — reach-passage/obtain-item
  // cover every real case, and having only two types is also why
  // discovery conditions no longer need their own separate type list
  // (they used to exclude "manual"; now there's nothing left to exclude).
  const CONDITION_TYPES = [
    { type: "reach-passage", label: "Reach a passage" },
    { type: "obtain-item",   label: "Obtain an item" }
  ];

  // Text typed into the Quests contents-sidebar search — module-level,
  // not reset on every render, so it survives switching tabs and coming
  // back. Cleared automatically once a tale has no quests left to search
  // (see renderQuestContentsSidebar) so it can't carry a stale filter
  // into an empty list.
  let questContentsSearchQuery = "";

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
    if (!quest.discoverConditions) quest.discoverConditions = [];
  }
  function ensureObjectiveMeta(obj) {
    if (!obj.tags) obj.tags = [];
    if (obj.notes === undefined) obj.notes = "";
    if (!obj.discoverConditions) obj.discoverConditions = [];
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
      (quest.discoverConditions || []).forEach(cond => {
        if (cond.type === conditionType && cond.target === oldId) {
          cond.target = newId;
          refCount++;
        }
      });
      (quest.objectives || []).forEach(obj => {
        (obj.conditions || []).forEach(cond => {
          if (cond.type === conditionType && cond.target === oldId) {
            cond.target = newId;
            refCount++;
          }
        });
        (obj.discoverConditions || []).forEach(cond => {
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
      discoverConditions: [],
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
    quest.objectives.push({ id, text: "", tags: [], notes: "", discoverConditions: [], conditions: [{ type: "reach-passage", target: "" }] });
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

  // conditions: the bare array to push/splice — obj.conditions or a
  // quest's/objective's discoverConditions, doesn't matter which, neither
  // function cares about the owner. defaultType just picks which of the
  // two condition types a freshly-added row starts as; "reach-passage" if
  // the caller doesn't care.
  function addCondition(conditions, defaultType) {
    conditions.push({ type: defaultType || "reach-passage", target: "" });
    touchCurrentTale();
  }

  // minCount: objectives must always keep at least one way to complete
  // (1); discoverConditions can be emptied all the way to zero, which is
  // exactly what "always visible" means, so it defaults to 0.
  function removeCondition(conditions, index, minCount) {
    if (conditions.length <= (minCount === undefined ? 1 : minCount)) return;
    conditions.splice(index, 1);
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
      renderQuestContentsSidebar();
      return;
    }

    ids.forEach(id => wrap.appendChild(buildQuestCard(gmStory.quests[id])));
    renderInspector();
    renderQuestContentsSidebar();
  }

  function questSummaryText(quest) {
    const count = quest.objectives.length;
    return (quest.title || "Untitled quest") + "  \u2014  " + count + " objective" + (count === 1 ? "" : "s");
  }

  function buildQuestCard(quest) {
    const isExpanded = expandedQuestId === quest.id;

    const card = buildAccordionCard({
      isExpanded,
      onToggle: () => {
        // Real toggle again: expand if collapsed, collapse if already
        // open. A previous version made this expand-only, reasoning that
        // clicking an already-open quest's header to reselect it (rather
        // than actually intending to close it) was collapsing the card
        // out from under the reader — but that traded one bug for
        // another: cards became impossible to close on their own, only
        // ever closing when a different one was opened. Reverting to a
        // genuine per-card toggle.
        expandedQuestId = isExpanded ? null : quest.id;
        gmInspectorSelection = { kind: "quest", id: quest.id };
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

        if (!quest.discoverConditions) quest.discoverConditions = [];
        body.appendChild(buildDiscoveryConditionsUI(quest.discoverConditions));

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

        // A plain touch anywhere else in the card (title, description,
        // Discovery, blank padding — not just the header) locks the
        // Inspector back onto this quest. Objective blocks stop this
        // click from bubbling here (see buildObjectiveBlock), so a touch
        // inside one of them selects that objective instead, not this.
        // renderInspector() only, same reasoning as the objective side:
        // a full render() here would rebuild the very card being clicked
        // and yank focus out of whatever field was just touched.
        body.addEventListener("click", () => {
          const alreadySelected = gmInspectorSelection && gmInspectorSelection.kind === "quest" &&
            gmInspectorSelection.id === quest.id;
          if (alreadySelected) return;
          gmInspectorSelection = { kind: "quest", id: quest.id };
          // Same reasoning as the objective side: move the ring by hand
          // rather than relying on a full render() to catch up. Selecting
          // the quest means no objective should show a ring at all.
          document.querySelectorAll(".quest-objective.inspector-selected")
            .forEach(el => el.classList.remove("inspector-selected"));
          renderInspector();
        });
      }
    });

    // (No .inspector-selected class here — see the CSS comment on that
    // rule for why the quest card itself doesn't need a selection ring.)
    return card;
  }

  // Same OR'd-conditions shape and UI as an objective's completion
  // conditions, scoped to whatever's visibility this is gating: a whole
  // quest (in the journal) or one objective within an already-visible
  // quest (in that quest's objective list). showHeading distinguishes the
  // two UIs — the quest's card has room for a labeled "Discovery"
  // subsection with an explicit "visible from the start" default-state
  // hint; an objective card is already dense (numbered row, text field,
  // its own completion conditions below), so the objective variant below
  // skips both and collapses to just the button when there's nothing to
  // show, so authors who never hide an objective see one extra line, not
  // a whole extra labeled section per objective.
  function buildDiscoveryConditionsUI(conditions, options) {
    const showHeading = !options || options.showHeading !== false;
    const wrap = document.createElement("div");
    wrap.className = "quest-objectives-block";

    if (showHeading) {
      const head = document.createElement("p");
      head.className = "gm-subhead";
      head.textContent = "Discovery";
      wrap.appendChild(head);
    }

    if (conditions.length === 0) {
      if (showHeading) {
        const hint = document.createElement("p");
        hint.className = "hint";
        hint.style.textAlign = "left";
        hint.textContent = "Visible in the journal from the start.";
        wrap.appendChild(hint);
      }
    } else {
      const label = document.createElement("p");
      label.className = "hint-inline";
      label.textContent = "Hidden until any one of these is true:";
      wrap.appendChild(label);

      conditions.forEach((cond, ci) => {
        if (ci > 0) {
          const orTag = document.createElement("p");
          orTag.className = "quest-condition-or";
          orTag.textContent = "or";
          wrap.appendChild(orTag);
        }
        wrap.appendChild(buildConditionRow(conditions, cond, ci, { minCount: 0 }));
      });
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn-tiny";
    addBtn.style.marginTop = "8px";
    addBtn.textContent = "+ Hide until a condition is met";
    addBtn.addEventListener("click", () => addCondition(conditions, "reach-passage"));
    wrap.appendChild(addBtn);

    return wrap;
  }

  function buildObjectiveBlock(quest, obj, index) {
    if (!obj.discoverConditions) obj.discoverConditions = [];

    const block = document.createElement("div");
    const isSelected = gmInspectorSelection && gmInspectorSelection.kind === "objective" &&
      gmInspectorSelection.questId === quest.id && gmInspectorSelection.objectiveId === obj.id;
    block.className = "quest-objective" + (isSelected ? " inspector-selected" : "");

    // A plain touch anywhere on this card (not just an input gaining
    // focus) locks the Inspector onto this objective — stopPropagation
    // keeps the click from also bubbling up and re-selecting the parent
    // quest (see the matching listener on the quest card's body).
    // renderInspector() only, not the full render(): a full re-render
    // would rebuild this very card and yank focus back out of whatever
    // field the reader just touched. The selection ring itself catches
    // up on the next full render (e.g. once a change event fires), same
    // as it already does for the "1." button's render()-triggered version.
    block.addEventListener("click", (e) => {
      e.stopPropagation();
      const alreadySelected = gmInspectorSelection && gmInspectorSelection.kind === "objective" &&
        gmInspectorSelection.questId === quest.id && gmInspectorSelection.objectiveId === obj.id;
      if (alreadySelected) return;
      gmInspectorSelection = { kind: "objective", questId: quest.id, objectiveId: obj.id };
      // Move the ring by hand instead of waiting for a full render() to
      // recompute it: renderInspector() only touches the side panel, so
      // without this the ring would silently lag a click behind (or
      // never move at all if nothing else happens to trigger a full
      // render() afterward) — confirmed with a jsdom harness before this
      // fix, the class genuinely never got applied via this click path.
      document.querySelectorAll(".quest-objective.inspector-selected")
        .forEach(el => el.classList.remove("inspector-selected"));
      block.classList.add("inspector-selected");
      renderInspector();
    });

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

    // Compact discovery control — see buildDiscoveryConditionsUI's header
    // comment for why this omits the quest-level version's heading/hint.
    block.appendChild(buildDiscoveryConditionsUI(obj.discoverConditions, { showHeading: false }));

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
      block.appendChild(buildConditionRow(obj.conditions, cond, ci, { minCount: 1 }));
    });

    const addCondBtn = document.createElement("button");
    addCondBtn.type = "button";
    addCondBtn.className = "btn-tiny";
    addCondBtn.style.marginTop = "8px";
    addCondBtn.textContent = "+ Add another way to complete this";
    addCondBtn.addEventListener("click", () => addCondition(obj.conditions));
    block.appendChild(addCondBtn);

    return block;
  }

  // conditions: the bare array this row edits. options: { minCount } to
  // control when the Remove button appears (see removeCondition above).
  function buildConditionRow(conditions, cond, index, options) {
    const minCount = (options && options.minCount !== undefined) ? options.minCount : 1;

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
      cond.target = cond.target || "";
      touchCurrentTale();
    });
    typeField.appendChild(select);
    row.appendChild(typeField);

    {
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

    if (conditions.length > minCount) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "gm-remove-choice";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", () => removeCondition(conditions, index, minCount));
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

  // Missing target skips the row entirely — covers both an actual gap
  // (a condition switched types and hasn't been given a new target yet)
  // and a legacy {type:"manual"} condition from before that type was
  // removed (manual conditions never had a target field at all). Also
  // collapses duplicates to one row — the point of this list is "what
  // does this depend on," not "how many times."
  function dedupeRefs(conditions) {
    const seen = new Set();
    const out = [];
    (conditions || []).forEach(cond => {
      if (!cond.target) return;
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

  // A reference whose target no longer exists — a passage or item that got
  // deleted without anything cleaning up what pointed at it (deleting a
  // passage doesn't fan out to quest conditions any more than it fans out
  // to other passages' choices — that's a known gap). refDisplayLabel
  // already appends "(missing)" as text; this drives the louder visual
  // treatment (warning icon, red border) so it can't be skimmed past.
  function referenceExists(cond) {
    if (cond.type === "reach-passage") return !!gmStory.nodes[cond.target];
    if (cond.type === "obtain-item") return !!gmStory.items[cond.target];
    return true;
  }

  // Cross-quest awareness: if another quest's conditions target the same
  // passage/item, surface that here. Catches accidental duplication once a
  // tale has more than a couple quests — "oh, Find the Sword already needs
  // this too" is easy to lose track of without something naming it.
  // excludeQuestId is always the quest CONTAINING whatever's being
  // inspected (the quest itself, or an objective's parent) — reuse within
  // the same quest doesn't count as "cross-quest."
  function otherQuestsReferencing(type, target, excludeQuestId) {
    return Object.values(gmStory.quests).filter(q => {
      if (q.id === excludeQuestId) return false;
      return (q.objectives || []).some(o => (o.conditions || []).some(c => c.type === type && c.target === target));
    });
  }

  function buildReferenceList(refs, containingQuestId) {
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
      const exists = referenceExists(cond);
      const row = document.createElement("div");
      row.className = "quest-inspector-ref-row";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "quest-inspector-ref-btn" + (exists ? "" : " broken");

      const kindTag = document.createElement("span");
      kindTag.className = "quest-inspector-ref-kind";
      kindTag.textContent = cond.type === "reach-passage" ? "Passage" : "Item";
      btn.appendChild(kindTag);

      if (!exists) {
        const warnIcon = document.createElement("span");
        warnIcon.className = "quest-inspector-ref-warn";
        warnIcon.textContent = "\u26a0";
        warnIcon.setAttribute("aria-hidden", "true");
        btn.appendChild(warnIcon);
      }

      btn.appendChild(document.createTextNode(refDisplayLabel(cond)));
      btn.addEventListener("click", () => jumpToReference(cond));
      row.appendChild(btn);

      const sharedWith = otherQuestsReferencing(cond.type, cond.target, containingQuestId);
      if (sharedWith.length > 0) {
        const shared = document.createElement("p");
        shared.className = "quest-inspector-ref-shared";
        shared.appendChild(document.createTextNode("Also used by: "));
        sharedWith.forEach((q, i) => {
          if (i > 0) shared.appendChild(document.createTextNode(", "));
          const link = document.createElement("button");
          link.type = "button";
          link.className = "quest-inspector-parent-link";
          link.textContent = q.title || "Untitled quest";
          link.addEventListener("click", () => {
            expandedQuestId = q.id;
            gmInspectorSelection = { kind: "quest", id: q.id };
            render();
          });
          shared.appendChild(link);
        });
        row.appendChild(shared);
      }

      wrap.appendChild(row);
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

  // References section gets its own title builder: the count of broken
  // refs needs to be visible at a glance, not just discoverable by reading
  // every row — a quest with 5 references and 1 broken one shouldn't
  // require scanning all 5 to notice.
  function appendReferencesTitle(body, refs) {
    const brokenCount = refs.filter(r => !referenceExists(r)).length;
    const el = document.createElement("p");
    el.className = "quest-inspector-section-title";
    el.textContent = "References";
    if (brokenCount > 0) {
      const warn = document.createElement("span");
      warn.className = "quest-inspector-section-warn";
      warn.textContent = "\u26a0 " + brokenCount + " broken";
      el.appendChild(document.createTextNode(" "));
      el.appendChild(warn);
    }
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

    const questRefs = dedupeRefs(
      quest.objectives.flatMap(o => (o.conditions || []).concat(o.discoverConditions || [])).concat(quest.discoverConditions || [])
    );
    appendReferencesTitle(body, questRefs);
    body.appendChild(buildReferenceList(questRefs, quest.id));

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

    const objRefs = dedupeRefs((obj.conditions || []).concat(obj.discoverConditions || []));
    appendReferencesTitle(body, objRefs);
    body.appendChild(buildReferenceList(objRefs, quest.id));

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

  /* ---- Contents sidebar (Quests flavor) --------------------------------
     The Contents sidebar is shared chrome (index.html), but what it shows
     is view-specific — see setGmView() in grimoire-manager.js, which calls
     this while Quests is active and restores the passage tree
     (NodeGraph.renderContentsSidebar()) everywhere else. Reuses the exact
     same .gm-contents-row/.gm-contents-icon/.gm-contents-label classes the
     passage tree uses, so the sidebar's visual language doesn't shift
     depending on which tab put something there — only the icon and what
     clicking a row does changes. */
  function renderQuestContentsSidebar() {
    const tree = document.getElementById("gm-contents-tree");
    const heading = document.getElementById("gm-contents-heading");
    if (!tree) return;
    if (heading) heading.textContent = "Quests";
    tree.innerHTML = "";

    const ids = Object.keys(gmStory.quests || {});
    if (ids.length === 0) {
      questContentsSearchQuery = ""; // nothing to search — don't carry a stale query into a tale that later gets its first quest
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.style.textAlign = "left";
      empty.textContent = "No quests yet.";
      tree.appendChild(empty);
      return;
    }

    // Built once here, then left alone — renderQuestList (below) rebuilds
    // only the row list on every keystroke, not this input, or typing a
    // second character would recreate the input out from under the first
    // and yank focus away (the same class of bug fixed earlier for the
    // objective-selection ring, just via a rebuild instead of a render()).
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "gm-contents-search";
    searchInput.placeholder = "Search quests\u2026";
    searchInput.value = questContentsSearchQuery;
    searchInput.addEventListener("input", () => {
      questContentsSearchQuery = searchInput.value;
      renderQuestContentsList(tree, searchInput.value);
    });
    tree.appendChild(searchInput);

    renderQuestContentsList(tree, questContentsSearchQuery);
  }

  // Rebuilds just the row list (or the "no matches" message) beneath the
  // search input — split out from renderQuestContentsSidebar so a
  // keystroke never touches the input element itself. Matches on title
  // only: description/objective text lives one click away in the card
  // itself, and a sidebar meant for quickly locating a quest by name
  // doesn't need to double as a full-text search of its contents.
  function renderQuestContentsList(tree, rawQuery) {
    tree.querySelectorAll(".gm-contents-list, .gm-contents-search-empty").forEach(el => el.remove());

    const query = rawQuery.trim().toLowerCase();
    const ids = Object.keys(gmStory.quests || {}).filter(id => {
      if (!query) return true;
      return (gmStory.quests[id].title || "").toLowerCase().includes(query);
    });

    if (ids.length === 0) {
      const empty = document.createElement("p");
      empty.className = "hint gm-contents-search-empty";
      empty.style.textAlign = "left";
      empty.textContent = "No quests match \u201c" + rawQuery.trim() + "\u201d.";
      tree.appendChild(empty);
      return;
    }

    const list = document.createElement("ul");
    list.className = "gm-contents-list";

    ids.forEach(id => {
      const quest = gmStory.quests[id];
      const isActive = expandedQuestId === id;

      const item = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "gm-contents-row" + (isActive ? " active" : "");
      row.title = quest.title || id;

      const icon = document.createElement("span");
      icon.className = "gm-contents-icon icon-quest";
      icon.textContent = "\u2726";
      icon.setAttribute("aria-hidden", "true");
      row.appendChild(icon);

      const label = document.createElement("span");
      label.className = "gm-contents-label";
      label.textContent = quest.title || "Untitled quest";
      row.appendChild(label);

      row.addEventListener("click", () => {
        expandedQuestId = id;
        gmInspectorSelection = { kind: "quest", id };
        render();
      });

      item.appendChild(row);
      list.appendChild(item);
    });

    tree.appendChild(list);
  }

  document.getElementById("gm-quest-new-btn").addEventListener("click", createQuest);

  return { render, renameConditionTargets };
})();