/* =========================================================
   NodeGraph — the visual, interactive map of a tale's passages.

   Kept in its own plain <script> (loaded after script.js) rather
   than merged in — this is a self-contained subsystem (layout math,
   drag handling, pan/zoom, grouping, SVG wire drawing) and keeping
   it separate keeps its diffs from tangling with script.js's. ES
   modules aren't an option since the app runs off file:// and
   browsers block module imports there — so this is just sequential
   global scope, same as script.js. It reads gmStory,
   analyzeStoryFlow(), slugify(), showPrompt(), showToast(), and
   touchCurrentTale() as globals script.js already defines, and
   calls back into enterPassageEditor() on a plain click. Everything
   this file owns is namespaced under NodeGraph so it isn't adding
   more bare globals on top of the ones already there.

   Chapters as grouping, not a smarter layout algorithm: passages
   sharing a non-empty `chapter` field (2 or more of them) collapse
   into a single "chapter" node at the top level, styled as a
   stacked card. Clicking one submerges into that chapter's own
   flat sub-graph — same node-drag/connect/search machinery as the
   top level, just scoped to that chapter's passages. A breadcrumb
   ("‹ Back") pops back out. This mirrors how professional
   narrative tools (e.g. articy:draft's Flow Fragments) handle
   scale — nesting/collapsing, not a fancier auto-layout — since no
   layout algorithm stays readable forever as a tale grows, but a
   tale organized into chapters stays readable at any size because
   each view only ever shows one chapter's worth of passages.

   Interactions:
   - Click a passage              -> open it in the passage editor.
   - Click a chapter-group node   -> submerge into that chapter.
   - "‹ Back" breadcrumb           -> pop back out to the top level.
   - Drag a node                  -> reposition it; saved to
                                      gmStory.layout[id] (passages)
                                      or gmStory.groupLayout[key]
                                      (chapter groups); persists.
   - Drag from a node's gold
     connector dot onto
     another node                 -> adds a new choice linking them
                                      (dropped on a group, links to
                                      that chapter's entry passage).
   - Drag the connector onto
     empty canvas                 -> creates a brand-new passage
                                      where you dropped it, linked,
                                      in the current chapter scope.
   - Double-click empty canvas    -> creates a new, unlinked passage
                                      in the current chapter scope.
   - Drag empty canvas            -> pans the graph.
   - Mouse wheel                  -> zooms, centered on the cursor.
   - Trackpad two-finger swipe    -> pans.
   - Ctrl/Cmd+scroll              -> zooms (covers trackpad pinch too).
   - Shift+scroll                 -> pans horizontally.
   - Search box                   -> dims non-matching passages/groups
                                      and centers the view on the first
                                      hit (searches inside group members
                                      too).
   The page itself never scrolls; all of this happens inside the
   graph via a CSS transform (translate + scale) on the canvas.
   ========================================================= */

const NodeGraph = (() => {
  const NODE_W = 280;
  const NODE_H = 150;
  const CANVAS_PAD = 220;  // buffer on the right/bottom for dangling/external-link stubs AND their text labels (SVG clips anything past its own width)
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 2.5;
  const GROUP_PREFIX = "\u00A7"; // "§" — never produced by slugify(), so group keys can't collide with a real passage id

  let viewportEl = null;
  let canvasEl = null;
  let wiresSvg = null;
  let liveLayer = null;
  let currentPositions = {};   // key -> {x, y}, canvas-space (pre-transform). Key is a passage id, or a group key.
  let currentDescriptors = {}; // key -> {kind:'passage', passageId} | {kind:'group', key, chapter, memberIds}. Empty while submerged.
  let currentContainerOf = {}; // passageId -> key (top level only, empty while submerged)
  let currentMemberIds = [];   // this chapter's passage ids (submerged only, empty at top level)
  let scopeChapter = null;     // null = top-level grouped view; a chapter string = submerged into it
  let wired = false;           // guards against re-attaching static listeners on every render

  let panX = 40, panY = 40, scale = 1;

  function ensureLayout(story) {
    if (!story.layout) story.layout = {};
    return story.layout;
  }
  function ensureGroupLayout(story) {
    if (!story.groupLayout) story.groupLayout = {};
    return story.groupLayout;
  }

  function applyTransform() {
    canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  function resetView() {
    scale = 1;
    scopeChapter = null;
  }

  // ---- Chapter grouping -----------------------------------------------

  function chapterMembers(story, chapter) {
    return Object.keys(story.nodes).filter(id => (story.nodes[id].chapter || "").trim() === chapter);
  }

  function countChapterEntries(story, memberIds) {
    const memberSet = new Set(memberIds);
    let count = 0;
    Object.keys(story.nodes).forEach(id => {
      if (memberSet.has(id)) return;
      (story.nodes[id].choices || []).forEach(c => {
        if (c.to && memberSet.has(c.to)) count++;
      });
    });
    return count;
  }

  // Chapter labels in this app conventionally read like "II — The Vault"
  // (a roman numeral/number plus a descriptive part). Splitting on that
  // dash gives the group card a proper title + subtitle without needing a
  // separate "chapter description" field — falls back to the whole
  // string as the title if a chapter doesn't follow that convention.
  function splitChapterLabel(chapter) {
    const m = chapter.match(/^(.+?)\s+[—-]\s+(.+)$/);
    return m ? { title: m[1], subtitle: m[2] } : { title: chapter, subtitle: "chapter" };
  }

  // Chapters with 2+ passages become groups; a chapter with only one
  // passage isn't worth a container, so that passage just renders as a
  // normal node — this also means a group that's been dragged/edited
  // down to one member gracefully un-collapses on its own.
  function computeChapterGroups(story) {
    const byChapter = {};
    Object.keys(story.nodes).forEach(id => {
      const ch = (story.nodes[id].chapter || "").trim();
      if (!ch) return;
      (byChapter[ch] = byChapter[ch] || []).push(id);
    });
    const groups = {};
    Object.keys(byChapter).forEach(ch => {
      if (byChapter[ch].length >= 2) groups[ch] = byChapter[ch];
    });
    return groups;
  }

  // The passage a submerged view (or a connector dropped on a group card)
  // should treat as "the way in": whichever member is linked to from
  // outside the chapter, "start" if it's a member, a member with no
  // incoming link from another member in the chapter (i.e. the actual
  // root of its internal chain), or — last resort — the first member
  // alphabetically.
  function findChapterEntry(story, memberIds) {
    const memberSet = new Set(memberIds);
    for (const id of Object.keys(story.nodes)) {
      if (memberSet.has(id)) continue;
      for (const c of (story.nodes[id].choices || [])) {
        if (c.to && memberSet.has(c.to)) return c.to;
      }
    }
    if (memberSet.has("start")) return "start";

    const hasInternalIncoming = new Set();
    memberIds.forEach(id => {
      (story.nodes[id].choices || []).forEach(c => {
        if (c.to && memberSet.has(c.to)) hasInternalIncoming.add(c.to);
      });
    });
    const root = memberIds.find(id => !hasInternalIncoming.has(id));
    return root || memberIds.slice().sort()[0];
  }

  function buildTopLevelDescriptors(story) {
    const groups = computeChapterGroups(story);
    const descriptors = {};
    const containerOf = {};

    Object.keys(groups).forEach(chapter => {
      const key = GROUP_PREFIX + chapter;
      descriptors[key] = { kind: "group", key, chapter, memberIds: groups[chapter] };
      groups[chapter].forEach(id => { containerOf[id] = key; });
    });
    Object.keys(story.nodes).forEach(id => {
      if (containerOf[id]) return;
      descriptors[id] = { kind: "passage", passageId: id };
      containerOf[id] = id;
    });
    return { descriptors, containerOf };
  }

  // ---- Layout (auto-position fallback for anything without a saved spot) ----

  function outgoingContainerKeys(story, descriptors, containerOf, key) {
    const desc = descriptors[key];
    const memberIds = desc.kind === "group" ? desc.memberIds : [desc.passageId];
    const targets = new Set();
    memberIds.forEach(id => {
      (story.nodes[id].choices || []).forEach(c => {
        if (c.to && story.nodes[c.to]) {
          const targetKey = containerOf[c.to];
          if (targetKey && targetKey !== key) targets.add(targetKey);
        }
      });
    });
    return Array.from(targets);
  }

  // BFS from whichever container holds "start" gives every group/passage
  // a sensible default column (depth) and row — same shortest-path idea
  // as before, just operating over the virtual (grouped) graph instead
  // of individual passages.
  function topLevelAutoPositions(story, descriptors, containerOf) {
    const startKey = containerOf.start;
    const columns = [];
    const seen = new Set();

    if (startKey) {
      const queue = [[startKey, 0]];
      while (queue.length) {
        const [key, d] = queue.shift();
        if (seen.has(key) || !descriptors[key]) continue;
        seen.add(key);
        (columns[d] = columns[d] || []).push(key);
        outgoingContainerKeys(story, descriptors, containerOf, key).forEach(t => {
          if (!seen.has(t)) queue.push([t, d + 1]);
        });
      }
    }
    const orphanDepth = columns.length;
    Object.keys(descriptors).forEach(key => {
      if (!seen.has(key)) (columns[orphanDepth] = columns[orphanDepth] || []).push(key);
    });

    const COL_W = 350, ROW_H = 190, PAD_X = 50, PAD_Y = 60;
    const positions = {};
    columns.forEach((keys, d) => {
      (keys || []).forEach((key, row) => {
        positions[key] = { x: PAD_X + d * COL_W, y: PAD_Y + row * ROW_H };
      });
    });
    return positions;
  }

  function resolveTopLevelPositions(story, descriptors) {
    const layout = ensureLayout(story);
    const groupLayout = ensureGroupLayout(story);
    const auto = topLevelAutoPositions(story, descriptors, currentContainerOf);
    const positions = {};
    Object.keys(descriptors).forEach(key => {
      const desc = descriptors[key];
      const store = desc.kind === "group" ? groupLayout : layout;
      const storeKey = desc.kind === "group" ? key : desc.passageId;
      positions[key] = store[storeKey] || auto[key] || { x: 40, y: 40 };
      if (!store[storeKey]) store[storeKey] = positions[key];
    });
    return positions;
  }

  function scopedAutoPositions(story, memberIds) {
    const memberSet = new Set(memberIds);
    const entry = findChapterEntry(story, memberIds);
    const columns = [];
    const seen = new Set();

    if (entry) {
      const queue = [[entry, 0]];
      while (queue.length) {
        const [id, d] = queue.shift();
        if (seen.has(id) || !memberSet.has(id)) continue;
        seen.add(id);
        (columns[d] = columns[d] || []).push(id);
        (story.nodes[id].choices || []).forEach(c => {
          if (c.to && memberSet.has(c.to) && !seen.has(c.to)) queue.push([c.to, d + 1]);
        });
      }
    }
    const orphanDepth = columns.length;
    memberIds.forEach(id => {
      if (!seen.has(id)) (columns[orphanDepth] = columns[orphanDepth] || []).push(id);
    });

    const COL_W = 340, ROW_H = 180, PAD_X = 50, PAD_Y = 60;
    const positions = {};
    columns.forEach((ids, d) => {
      (ids || []).forEach((id, row) => {
        positions[id] = { x: PAD_X + d * COL_W, y: PAD_Y + row * ROW_H };
      });
    });
    return positions;
  }

  function resolveScopedPositions(story, memberIds) {
    const layout = ensureLayout(story);
    const auto = scopedAutoPositions(story, memberIds);
    const positions = {};
    memberIds.forEach(id => {
      positions[id] = layout[id] || auto[id] || { x: 40, y: 40 };
      if (!layout[id]) layout[id] = positions[id];
    });
    return positions;
  }

  // ---- Geometry (shared by both levels — agnostic to what a "key" is) ----

  function edgePoint(pos, side) {
    return { x: pos.x + (side === "right" ? NODE_W : 0), y: pos.y + NODE_H / 2 };
  }

  function wirePath(from, to) {
    const dx = Math.max(40, Math.abs(to.x - from.x) / 2);
    const sign = to.x >= from.x ? 1 : -1;
    return `M ${from.x} ${from.y} C ${from.x + dx * sign} ${from.y}, ${to.x - dx * sign} ${to.y}, ${to.x} ${to.y}`;
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
    return el;
  }

  // A row of small stat groups ("3 choices", "1 grants"...), separated by
  // the same small diamond flourish already used elsewhere in the app
  // (the satchel panel's corner accents) rather than introducing a new
  // icon vocabulary the rest of the app doesn't have.
  function buildMetaBar(stats) {
    const bar = document.createElement("div");
    bar.className = "graph-node-meta";
    stats.forEach((stat, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "meta-sep";
        sep.textContent = "\u25C6"; // ◆
        bar.appendChild(sep);
      }
      const group = document.createElement("span");
      group.className = "meta-stat";
      const value = document.createElement("strong");
      value.textContent = stat.value;
      const label = document.createElement("i");
      label.textContent = " " + stat.label;
      group.appendChild(value);
      group.appendChild(label);
      bar.appendChild(group);
    });
    return bar;
  }

  // clientX/clientY (screen space) -> canvas-space coordinates, accounting
  // for the current pan/zoom transform.
  function toCanvasPoint(clientX, clientY) {
    const rect = viewportEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left - panX) / scale,
      y: (clientY - rect.top - panY) / scale
    };
  }

  function resizeCanvasBounds() {
    let minX = 0, minY = 0, maxX = 300, maxY = 300;
    Object.values(currentPositions).forEach(p => {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + NODE_H);
    });
    const width = (maxX - minX) + CANVAS_PAD;
    const height = (maxY - minY) + CANVAS_PAD;
    canvasEl.style.width = width + "px";
    canvasEl.style.height = height + "px";
    [wiresSvg, liveLayer].forEach(svg => {
      // The SVG's own box has to start at (minX, minY) too, not just its
      // viewBox — otherwise a wire endpoint at a negative coordinate stays
      // clipped by the SVG's default overflow even once the viewBox covers it.
      svg.style.left = minX + "px";
      svg.style.top = minY + "px";
      svg.setAttribute("width", width);
      svg.setAttribute("height", height);
      svg.setAttribute("viewBox", `${minX} ${minY} ${width} ${height}`);
    });
  }

  function drawSolidWire(from, to) {
    wiresSvg.appendChild(svgEl("path", { d: wirePath(from, to), class: "graph-wire" }));
    wiresSvg.appendChild(svgEl("circle", { cx: from.x, cy: from.y, r: 4, class: "graph-dot" }));
    wiresSvg.appendChild(svgEl("circle", { cx: to.x, cy: to.y, r: 4, class: "graph-dot" }));
  }

  function drawStub(from, cssClass, labelText) {
    const stub = { x: from.x + 70, y: Math.max(16, from.y - 60) };
    wiresSvg.appendChild(svgEl("path", { d: wirePath(from, stub), class: "graph-wire " + cssClass }));
    wiresSvg.appendChild(svgEl("circle", { cx: from.x, cy: from.y, r: 4, class: "graph-dot" }));
    wiresSvg.appendChild(svgEl("circle", { cx: stub.x, cy: stub.y, r: 4, class: "graph-dot " + cssClass }));
    const label = svgEl("text", { x: stub.x + 8, y: stub.y - 6, class: "graph-dangling-label " + cssClass });
    label.textContent = labelText;
    wiresSvg.appendChild(label);
  }

  // Known limitation: deleting a passage doesn't clean up other passages'
  // choices that pointed to it. Rather than hiding that, the map surfaces
  // it as a dashed red stub — the same case renderNode() falls back to a
  // "doesn't exist yet" message for during playtest.
  function drawDanglingStub(from, targetId) {
    drawStub(from, "dangling", "broken link \u2192 \u201c" + targetId + "\u201d");
  }

  function buildTopLevelWires(story, descriptors, containerOf, positions) {
    const drawn = new Set();
    Object.keys(descriptors).forEach(key => {
      const desc = descriptors[key];
      const memberIds = desc.kind === "group" ? desc.memberIds : [desc.passageId];
      const fromPos = positions[key];
      if (!fromPos) return;
      const from = edgePoint(fromPos, "right");

      memberIds.forEach(id => {
        (story.nodes[id].choices || []).forEach(choice => {
          if (!choice.to) return;

          if (!story.nodes[choice.to]) {
            const dedupe = key + "\u2192!" + choice.to;
            if (drawn.has(dedupe)) return;
            drawn.add(dedupe);
            drawDanglingStub(from, choice.to);
            return;
          }

          const targetKey = containerOf[choice.to];
          if (!targetKey || targetKey === key) return; // internal-to-group link, not shown at this level
          const dedupe = key + "\u2192" + targetKey;
          if (drawn.has(dedupe)) return;
          drawn.add(dedupe);
          drawSolidWire(from, edgePoint(positions[targetKey], "left"));
        });
      });
    });
  }

  function buildScopedWires(story, memberIds, positions) {
    const memberSet = new Set(memberIds);
    memberIds.forEach(id => {
      const fromPos = positions[id];
      if (!fromPos) return;
      const from = edgePoint(fromPos, "right");

      (story.nodes[id].choices || []).forEach(choice => {
        if (!choice.to) return;

        if (!story.nodes[choice.to]) {
          drawDanglingStub(from, choice.to);
          return;
        }
        if (memberSet.has(choice.to)) {
          drawSolidWire(from, edgePoint(positions[choice.to], "left"));
          return;
        }
        // Leaves this chapter for a real passage elsewhere — a valid link,
        // just out of view right now, so it gets its own distinct (gold,
        // not red) stub rather than looking like a broken one.
        const targetChapter = (story.nodes[choice.to].chapter || "").trim();
        const label = targetChapter ? targetChapter : choice.to;
        drawStub(from, "external", "leaves to \u2192 " + label);
      });
    });
  }

  function redrawCurrentWires() {
    wiresSvg.innerHTML = "";
    if (scopeChapter === null) {
      buildTopLevelWires(gmStory, currentDescriptors, currentContainerOf, currentPositions);
    } else {
      buildScopedWires(gmStory, currentMemberIds, currentPositions);
    }
  }

  // ---- Drag / connect interactions -------------------------------------

  function attachDrag(card, key, onCommitPosition, onPlainClick) {
    const THRESH = 4;
    card.addEventListener("pointerdown", e => {
      if (e.target.closest(".graph-connector") || e.button !== 0) return;
      e.stopPropagation(); // don't also trigger canvas panning
      const startX = e.clientX, startY = e.clientY;
      const startLeft = currentPositions[key].x, startTop = currentPositions[key].y;
      let dragging = false;
      card.setPointerCapture(e.pointerId);

      function onMove(ev) {
        const dx = (ev.clientX - startX) / scale, dy = (ev.clientY - startY) / scale;
        if (!dragging && Math.hypot(dx, dy) > THRESH) { dragging = true; card.classList.add("dragging"); }
        if (!dragging) return;
        const nx = startLeft + dx;
        const ny = startTop + dy;
        currentPositions[key] = { x: nx, y: ny };
        card.style.left = nx + "px";
        card.style.top = ny + "px";
        resizeCanvasBounds();
        redrawCurrentWires();
      }
      function onUp() {
        card.releasePointerCapture(e.pointerId);
        card.removeEventListener("pointermove", onMove);
        card.removeEventListener("pointerup", onUp);
        card.classList.remove("dragging");
        if (dragging) {
          onCommitPosition({ ...currentPositions[key] });
          touchCurrentTale();
        } else {
          onPlainClick();
        }
      }
      card.addEventListener("pointermove", onMove);
      card.addEventListener("pointerup", onUp);
    });
  }

  function attachConnectorDrag(dot, sourceId) {
    dot.addEventListener("pointerdown", e => {
      e.stopPropagation();
      e.preventDefault();
      dot.setPointerCapture(e.pointerId);
      const sourceCard = dot.closest(".graph-node");
      if (sourceCard) sourceCard.classList.add("connecting");
      const from = edgePoint(currentPositions[sourceId], "right");
      const temp = svgEl("path", { class: "graph-wire temp" });
      liveLayer.appendChild(temp);

      function onMove(ev) {
        temp.setAttribute("d", wirePath(from, toCanvasPoint(ev.clientX, ev.clientY)));
      }

      async function onUp(ev) {
        dot.releasePointerCapture(e.pointerId);
        dot.removeEventListener("pointermove", onMove);
        dot.removeEventListener("pointerup", onUp);
        temp.remove();
        if (sourceCard) sourceCard.classList.remove("connecting");

        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetCard = under && under.closest(".graph-node");
        let targetId = targetCard && targetCard.dataset.nodeId;
        if (!targetId && targetCard && targetCard.dataset.nodeKey) {
          // Dropped on a chapter-group card — link to that chapter's entry passage.
          const desc = currentDescriptors[targetCard.dataset.nodeKey];
          if (desc && desc.kind === "group") targetId = findChapterEntry(gmStory, desc.memberIds);
        }

        if (targetId) {
          const label = await showPrompt("Choice text for this link:", "");
          if (label === null) return;
          gmStory.nodes[sourceId].choices = gmStory.nodes[sourceId].choices || [];
          gmStory.nodes[sourceId].choices.push({ label: label.trim() || "Continue", to: targetId });
          touchCurrentTale();
          render();
          return;
        }

        // Dropped on empty canvas — spin off a brand-new, already-linked passage,
        // in whichever chapter is currently in view.
        const raw = await showPrompt("Id for the new passage this connects to (letters and numbers only):");
        if (raw === null || !raw.trim()) return;
        const newId = slugify(raw) || ("passage" + Date.now());
        if (gmStory.nodes[newId]) { showToast("A passage with that id already exists."); return; }
        const label = await showPrompt("Choice text for this link:", "");
        if (label === null) return;

        const p = toCanvasPoint(ev.clientX, ev.clientY);
        gmStory.nodes[newId] = { chapter: scopeChapter || "", text: "", choices: [] };
        ensureLayout(gmStory)[newId] = { x: Math.max(0, p.x - NODE_W / 2), y: Math.max(0, p.y - NODE_H / 2) };
        gmStory.nodes[sourceId].choices = gmStory.nodes[sourceId].choices || [];
        gmStory.nodes[sourceId].choices.push({ label: label.trim() || "Continue", to: newId });
        touchCurrentTale();
        render();
      }
      dot.addEventListener("pointermove", onMove);
      dot.addEventListener("pointerup", onUp);
    });
  }

  // ---- Node cards -------------------------------------------------------

  function buildPassageNode(id, pos, reachable) {
    const node = gmStory.nodes[id];
    const isStart = id === "start";

    const card = document.createElement("div");
    card.className = "graph-node" +
      (isStart ? " is-start" : "") +
      (node.end ? " is-ending" : "") +
      (!reachable.has(id) ? " is-orphan" : "");
    card.dataset.nodeId = id;
    card.style.left = pos.x + "px";
    card.style.top = pos.y + "px";
    card.style.width = NODE_W + "px";
    card.style.height = NODE_H + "px"; // must match NODE_H exactly — edgePoint()/wire math assume it
    card.tabIndex = 0;

    if (isStart || node.end) {
      const ribbon = document.createElement("span");
      ribbon.className = "graph-node-ribbon";
      ribbon.title = isStart ? "Start passage" : "Ending";
      card.appendChild(ribbon);
    }

    const handle = document.createElement("span");
    handle.className = "graph-node-handle";
    handle.setAttribute("aria-hidden", "true");
    card.appendChild(handle);

    const title = document.createElement("span");
    title.className = "graph-node-title";
    title.textContent = id;
    card.appendChild(title);

    const hasChapter = node.chapter && node.chapter.trim();
    const sub = document.createElement("span");
    sub.className = "graph-node-sub" + (!node.end && !hasChapter ? " placeholder" : "");
    sub.textContent = node.end ? (node.endingType || "ending") : (hasChapter ? node.chapter : "untitled passage");
    card.appendChild(sub);

    const choices = node.choices || [];
    const stats = node.end
      ? [{ value: "\u2014", label: "choices" }, { value: "\u2014", label: "req." }]
      : [
          { value: choices.length, label: "choices" },
          { value: choices.filter(c => c.requires && c.requires.item).length, label: "req." },
          { value: choices.filter(c => c.grants && c.grants.item).length, label: "grants" }
        ];
    card.appendChild(buildMetaBar(stats));

    const dot = document.createElement("span");
    dot.className = "graph-connector";
    dot.title = "Drag to link this passage to another";
    card.appendChild(dot);

    attachDrag(card, id, pos2 => { ensureLayout(gmStory)[id] = pos2; }, () => enterPassageEditor(id));
    attachConnectorDrag(dot, id);
    return card;
  }

  function buildGroupNode(desc, pos, reachable) {
    const memberReachable = desc.memberIds.some(id => reachable.has(id));

    const card = document.createElement("div");
    card.className = "graph-node graph-node-group" + (!memberReachable ? " is-orphan" : "");
    card.dataset.nodeKey = desc.key;
    card.style.left = pos.x + "px";
    card.style.top = pos.y + "px";
    card.style.width = NODE_W + "px";
    card.style.height = NODE_H + "px";
    card.tabIndex = 0;
    card.title = "Open this chapter";

    const handle = document.createElement("span");
    handle.className = "graph-node-handle";
    handle.setAttribute("aria-hidden", "true");
    card.appendChild(handle);

    const parts = splitChapterLabel(desc.chapter);
    const title = document.createElement("span");
    title.className = "graph-node-title";
    title.textContent = parts.title;
    card.appendChild(title);

    const sub = document.createElement("span");
    sub.className = "graph-node-sub";
    sub.textContent = parts.subtitle;
    card.appendChild(sub);

    const entries = countChapterEntries(gmStory, desc.memberIds);
    card.appendChild(buildMetaBar([
      { value: desc.memberIds.length, label: "passages" },
      { value: entries, label: entries === 1 ? "entry" : "entries" }
    ]));

    attachDrag(
      card, desc.key,
      pos2 => { ensureGroupLayout(gmStory)[desc.key] = pos2; },
      () => submergeInto(desc.chapter)
    );
    return card;
  }

  // ---- Pan / zoom / fit / search ----------------------------------------

  function zoomAt(clientX, clientY, factor) {
    const rect = viewportEl.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const prevScale = scale;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    const cx = (px - panX) / prevScale, cy = (py - panY) / prevScale;
    panX = px - cx * scale;
    panY = py - cy * scale;
    applyTransform();
  }

  function focusOnKey(key) {
    const pos = currentPositions[key];
    if (!pos) return;
    const rect = viewportEl.getBoundingClientRect();
    const cx = pos.x + NODE_W / 2, cy = pos.y + NODE_H / 2;
    panX = rect.width / 2 - cx * scale;
    panY = rect.height / 2 - cy * scale;
    applyTransform();
  }

  function fitView() {
    const keys = Object.keys(currentPositions);
    if (!keys.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    keys.forEach(key => {
      const p = currentPositions[key];
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H);
    });
    const contentW = Math.max(1, maxX - minX), contentH = Math.max(1, maxY - minY);
    const rect = viewportEl.getBoundingClientRect();
    const PAD = 70;
    const fitScale = Math.min((rect.width - PAD * 2) / contentW, (rect.height - PAD * 2) / contentH);
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(fitScale, 1.2)));
    panX = rect.width / 2 - (minX + contentW / 2) * scale;
    panY = rect.height / 2 - (minY + contentH / 2) * scale;
    applyTransform();
  }

  function runSearch(query) {
    const q = query.trim().toLowerCase();
    let firstMatchKey = null;
    canvasEl.querySelectorAll(".graph-node").forEach(card => {
      let key, haystack;
      if (card.dataset.nodeId) {
        key = card.dataset.nodeId;
        const node = gmStory.nodes[key];
        haystack = (key + " " + (node.chapter || "") + " " + (node.text || "")).toLowerCase();
      } else {
        key = card.dataset.nodeKey;
        const desc = currentDescriptors[key];
        haystack = (desc.chapter + " " + desc.memberIds.map(id =>
          id + " " + (gmStory.nodes[id].text || "")).join(" ")).toLowerCase();
      }
      const match = !q || haystack.includes(q);
      card.classList.toggle("is-dimmed", !!q && !match);
      if (q && match && firstMatchKey === null) firstMatchKey = key;
    });
    if (q && firstMatchKey) focusOnKey(firstMatchKey);
  }

  // ---- Navigation ---------------------------------------------------------

  function submergeInto(chapter) {
    scopeChapter = chapter;
    render();
  }

  function popToTopLevel() {
    scopeChapter = null;
    render();
  }

  function updateBreadcrumb() {
    const bar = document.getElementById("gm-map-breadcrumb");
    const label = document.getElementById("gm-map-breadcrumb-label");
    if (!bar) return;
    bar.hidden = scopeChapter === null;
    if (scopeChapter !== null && label) label.textContent = scopeChapter;
  }

  // ---- Canvas pan / pinch-zoom (background drag) -----------------------
  // One tracked pointer pans; a second one turns the gesture into a pinch-
  // zoom, anchored to the midpoint between the two touches (same anchoring
  // idea as zoomAt() below, just anchored to a moving midpoint instead of
  // a fixed cursor position, since fingers drift while pinching). Pointer
  // Events already unify mouse/touch/pen, so a mouse drag is just the
  // "one pointer" case — no separate mouse-only code path needed. State
  // lives at this outer scope (rather than nested per-gesture closures
  // like the old single-pointer version) because a second pointerdown
  // fires as its own event while the first pointer's gesture is still in
  // progress, and two independent closures can't coordinate a two-finger
  // gesture between them.
  let activePointers = new Map(); // pointerId -> {x, y} client coords
  let panMode = null;             // "pan" | "pinch" | null
  let panDragging = false;        // crossed the pan-vs-tap threshold yet?
  let panStart = null;            // {x, y} client coords at pan gesture start
  let panOriginX = 0, panOriginY = 0; // panX/panY at pan gesture start
  let pinchStartDist = 0;
  let pinchStartMid = null;       // client-space midpoint at pinch start
  let pinchStartScale = 1;
  let pinchOriginPanX = 0, pinchOriginPanY = 0;

  function pointerDistance(p1, p2) { return Math.hypot(p1.x - p2.x, p1.y - p2.y); }
  function pointerMidpoint(p1, p2) { return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }; }

  function beginPan(atClient) {
    panMode = "pan";
    panStart = atClient;
    panOriginX = panX;
    panOriginY = panY;
  }

  function beginPinch() {
    const [p1, p2] = Array.from(activePointers.values());
    panMode = "pinch";
    pinchStartDist = pointerDistance(p1, p2);
    pinchStartMid = pointerMidpoint(p1, p2);
    pinchStartScale = scale;
    pinchOriginPanX = panX;
    pinchOriginPanY = panY;
    panDragging = true;
    viewportEl.classList.add("panning");
  }

  function attachViewportPanZoom() {
    viewportEl.addEventListener("pointerdown", e => {
      if (e.target.closest(".graph-node") || e.button !== 0) return;
      viewportEl.setPointerCapture(e.pointerId);
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (activePointers.size === 2) {
        beginPinch();
      } else if (activePointers.size === 1) {
        panDragging = false;
        beginPan({ x: e.clientX, y: e.clientY });
      }
    });

    viewportEl.addEventListener("pointermove", e => {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (panMode === "pinch" && activePointers.size >= 2) {
        const [p1, p2] = Array.from(activePointers.values());
        const dist = pointerDistance(p1, p2);
        const mid = pointerMidpoint(p1, p2);
        const rect = viewportEl.getBoundingClientRect();
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale * (dist / pinchStartDist)));
        const anchorX = pinchStartMid.x - rect.left, anchorY = pinchStartMid.y - rect.top;
        const cx = (anchorX - pinchOriginPanX) / pinchStartScale;
        const cy = (anchorY - pinchOriginPanY) / pinchStartScale;
        const curX = mid.x - rect.left, curY = mid.y - rect.top;
        scale = newScale;
        panX = curX - cx * scale;
        panY = curY - cy * scale;
        applyTransform();
      } else if (panMode === "pan") {
        const dx = e.clientX - panStart.x, dy = e.clientY - panStart.y;
        if (!panDragging && Math.hypot(dx, dy) > 4) { panDragging = true; viewportEl.classList.add("panning"); }
        if (!panDragging) return;
        panX = panOriginX + dx;
        panY = panOriginY + dy;
        applyTransform();
      }
    });

    function endPointer(e) {
      if (!activePointers.has(e.pointerId)) return;
      activePointers.delete(e.pointerId);
      try { viewportEl.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }

      if (activePointers.size === 1) {
        // Dropped from two fingers to one — resume single-pointer panning
        // from the remaining finger's current position rather than
        // jumping back to wherever the two-finger gesture originally
        // started.
        const [remaining] = Array.from(activePointers.values());
        panDragging = true; // already mid-gesture; skip re-crossing the threshold
        beginPan(remaining);
      } else if (activePointers.size === 0) {
        panMode = null;
        panDragging = false;
        viewportEl.classList.remove("panning");
      }
    }
    viewportEl.addEventListener("pointerup", endPointer);
    viewportEl.addEventListener("pointercancel", endPointer);
  }

  // ---- Static (attach-once) listeners: pan, zoom, add, search, breadcrumb ----

  function attachStaticListenersOnce() {
    if (wired) return;
    wired = true;

    attachViewportPanZoom();

    // A mouse wheel only ever reports a vertical delta with no horizontal
    // component — so a plain vertical tick zooms, which is what a mouse
    // user expects from "the roller". A trackpad's two-finger swipe
    // reports a horizontal delta too, so that's treated as a pan instead.
    // Ctrl/Cmd+scroll (how browsers report a trackpad pinch, or an
    // explicit request to zoom) always zooms. Shift+scroll pans
    // horizontally — the standard browser convention.
    viewportEl.addEventListener("wheel", e => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.012));
      } else if (e.shiftKey) {
        panX -= e.deltaY;
        applyTransform();
      } else if (e.deltaX !== 0) {
        panX -= e.deltaX;
        panY -= e.deltaY;
        applyTransform();
      } else {
        zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.001));
      }
    }, { passive: false });

    canvasEl.addEventListener("dblclick", async e => {
      if (e.target.closest(".graph-node")) return;
      const p = toCanvasPoint(e.clientX, e.clientY);
      const raw = await showPrompt("Id for the new passage (letters and numbers only, e.g. 'throneRoom'):");
      if (raw === null || !raw.trim()) return;
      const id = slugify(raw) || ("passage" + Date.now());
      if (gmStory.nodes[id]) { showToast("A passage with that id already exists."); return; }
      gmStory.nodes[id] = { chapter: scopeChapter || "", text: "", choices: [] };
      ensureLayout(gmStory)[id] = { x: Math.max(0, p.x - NODE_W / 2), y: Math.max(0, p.y - NODE_H / 2) };
      touchCurrentTale();
      render();
    });

    const searchBtn = document.getElementById("gm-map-search-btn");
    const searchInput = document.getElementById("gm-map-search-input");
    searchBtn.addEventListener("click", () => {
      const showing = !searchInput.hidden;
      if (showing) {
        searchInput.hidden = true;
        searchInput.value = "";
        runSearch("");
      } else {
        searchInput.hidden = false;
        searchInput.focus();
      }
    });
    searchInput.addEventListener("input", () => runSearch(searchInput.value));
    searchInput.addEventListener("keydown", e => {
      if (e.key === "Escape") { searchInput.value = ""; runSearch(""); searchInput.blur(); }
    });

    const fitBtn = document.getElementById("gm-map-fit-btn");
    if (fitBtn) fitBtn.addEventListener("click", fitView);

    const upBtn = document.getElementById("gm-map-up-btn");
    if (upBtn) upBtn.addEventListener("click", popToTopLevel);
  }

  // Used by the map toolbar's "+ Passage" button: places the node at the
  // current center of the visible viewport (accounting for pan/zoom),
  // rather than the reader having to hunt for an off-screen passage.
  function placeNewNode(id) {
    const rect = viewportEl ? viewportEl.getBoundingClientRect() : { width: 600, height: 400 };
    const cx = (rect.width / 2 - panX) / scale;
    const cy = (rect.height / 2 - panY) / scale;
    ensureLayout(gmStory)[id] = { x: Math.max(0, cx - NODE_W / 2), y: Math.max(0, cy - NODE_H / 2) };
  }

  function currentChapter() {
    return scopeChapter;
  }

  function render(opts) {
    viewportEl = document.getElementById("graph-viewport");
    canvasEl = document.getElementById("graph-canvas");
    if (!viewportEl || !canvasEl || !gmStory) return;
    if (opts && opts.resetView) resetView();
    attachStaticListenersOnce();

    // A chapter that's been renamed/emptied out from under a submerged
    // view has nothing left to show — fall back to the top level rather
    // than rendering an empty canvas with no way out.
    let scopedMembers = scopeChapter !== null ? chapterMembers(gmStory, scopeChapter) : [];
    if (scopeChapter !== null && scopedMembers.length === 0) {
      scopeChapter = null;
    }

    canvasEl.innerHTML = "";
    const { reachable } = analyzeStoryFlow(gmStory);

    wiresSvg = svgEl("svg", { class: "graph-wires" });
    liveLayer = svgEl("svg", { class: "graph-live-layer" });
    canvasEl.appendChild(wiresSvg);
    canvasEl.appendChild(liveLayer);

    if (scopeChapter === null) {
      const { descriptors, containerOf } = buildTopLevelDescriptors(gmStory);
      currentDescriptors = descriptors;
      currentContainerOf = containerOf;
      currentMemberIds = [];
      currentPositions = resolveTopLevelPositions(gmStory, descriptors);

      resizeCanvasBounds();
      redrawCurrentWires();
      applyTransform();

      Object.keys(currentPositions).forEach(key => {
        const desc = descriptors[key];
        const card = desc.kind === "group"
          ? buildGroupNode(desc, currentPositions[key], reachable)
          : buildPassageNode(desc.passageId, currentPositions[key], reachable);
        canvasEl.appendChild(card);
      });
    } else {
      currentDescriptors = {};
      currentContainerOf = {};
      currentMemberIds = scopedMembers;
      currentPositions = resolveScopedPositions(gmStory, currentMemberIds);

      resizeCanvasBounds();
      redrawCurrentWires();
      applyTransform();

      currentMemberIds.forEach(id => {
        canvasEl.appendChild(buildPassageNode(id, currentPositions[id], reachable));
      });
    }

    updateBreadcrumb();
    if (opts && opts.resetView) fitView();
  }

  return { render, placeNewNode, fitView, currentChapter };
})();
