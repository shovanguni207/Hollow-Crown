/* =========================================================
   GRIMOIRE ITEMS — the item definition ledger. Scans every
   choice for grants/requires usage (which passages grant an
   item, which require it), so findItemLabel() (player.js)
   stays a simple lookup no matter how many choices reference
   the same item.
   ========================================================= */

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

/* ---- Renaming an item's id -------------------------------------------
   The id field in the item card is disabled on purpose — an id is a
   reference key, so changing it can't just be a text edit, it has to fan
   out to every place that reference lives. This does that fan-out: moves
   the registry entry to the new key, then walks every passage's choices
   AND every unsaved draft's choices (the editor allows several passages to
   have unsaved edits sitting in nodeDrafts at once — see captureNodeDraft
   in grimoire-editor.js — and a draft is what selectGmNode loads in
   preference to gmStory, so a stale id left behind there would silently
   resurrect itself the next time that passage is opened, or get written
   back out on its next save).
   Note the two structures use different shapes for the same reference:
   gmStory choices nest it as requires.item/grants.item, while draft
   choices (mirroring editingChoices) store it as flat requires/grantsItem
   strings. Returns how many choice references got updated across both,
   purely for the confirmation toast. */
function renameItemId(oldId, newId) {
  const def = gmStory.items[oldId];
  delete gmStory.items[oldId];
  gmStory.items[newId] = def;

  let refCount = 0;
  Object.values(gmStory.nodes).forEach(node => {
    (node.choices || []).forEach(choice => {
      if (choice.requires && choice.requires.item === oldId) {
        choice.requires.item = newId;
        refCount++;
      }
      if (choice.grants && choice.grants.item === oldId) {
        choice.grants.item = newId;
        refCount++;
      }
    });
  });

  Object.values(nodeDrafts).forEach(draft => {
    (draft.choices || []).forEach(c => {
      if (c.requires === oldId) { c.requires = newId; refCount++; }
      if (c.grantsItem === oldId) { c.grantsItem = newId; refCount++; }
    });
  });

  // Quest objectives can complete on "obtain this item" — same fan-out
  // problem, one level removed. See QuestEditor.renameConditionTargets
  // (quest-editor.js).
  refCount += QuestEditor.renameConditionTargets("obtain-item", oldId, newId);

  return refCount;
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

      const idRow = document.createElement("div");
      idRow.className = "id-row";

      const idInput = document.createElement("input");
      idInput.type = "text";
      idInput.value = id;
      idInput.disabled = true;
      idRow.appendChild(idInput);

      const changeIdBtn = document.createElement("button");
      changeIdBtn.type = "button";
      changeIdBtn.className = "btn-tiny";
      changeIdBtn.textContent = "Change id";
      changeIdBtn.addEventListener("click", async () => {
        const newId = await promptForNewId({
          subjectLabel: def.label || id,
          currentId: id,
          existingIds: Object.keys(gmStory.items)
        });
        if (!newId) return;

        const refCount = renameItemId(id, newId);

        // If the passage currently open in the editor references this item,
        // fix up its still-unsaved choice fields too, not just the stored data.
        editingChoices.forEach(c => {
          if (c.requires === id) c.requires = newId;
          if (c.grantsItem === id) c.grantsItem = newId;
        });

        if (expandedItemId === id) expandedItemId = newId;
        touchCurrentTale();
        renderChoiceRows();
        renderItemDefs();
        showToast("Item id updated" + (refCount ? " \u2014 " + refCount + " reference" + (refCount === 1 ? "" : "s") + " fixed up." : "."));
      });
      idRow.appendChild(changeIdBtn);
      idField.appendChild(idRow);
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

/* ---- Resolving item references typed into a choice's "requires"/"grants"
   field --------------------------------------------------------------
   Authors mostly discover items by typing a name straight into a choice
   card, not through the ledger's "+ Define new item" button. That field
   used to be treated as a raw item id — whatever was typed (spaces,
   capitals, everything) got saved as the id verbatim, with no registry
   entry and no way to clean it up afterwards (the id field is disabled by
   design; see renameItemId for the proper way to change one).
   This mirrors what "+ Define new item" already does: slugify what was
   typed into a clean id, and auto-register it (label = the text as typed)
   the first time it's referenced, so every item id in the tale — however
   it was created — stays well-formed from the start. */
function resolveItemRef(rawValue) {
  const raw = rawValue.trim();
  if (!raw) return "";
  if (!gmStory.items) gmStory.items = {};

  // Already a known id (typed exactly, or picked from the autocomplete) — leave it alone.
  if (gmStory.items[raw]) return raw;

  const id = slugify(raw) || ("item" + Date.now());
  if (!gmStory.items[id]) {
    gmStory.items[id] = { label: raw, description: "" };
  }
  return id;
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