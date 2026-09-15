/* =========================================================
   NodeGraph — the visual, interactive map of a tale's passages.

   Kept in its own plain <script> (loaded after script.js) rather
   than merged in — this is a self-contained subsystem (layout math,
   drag handling, pan/zoom, grouping, SVG wire drawing) and keeping
   it separate keeps its diffs from tangling with script.js's. ES
   modules aren't an option since the app runs off file:// and
   browsers block module imports there — so this is just sequential
   global scope, same as script.js. It reads gmStory,
   analyzeStoryFlow(), slugify(), uniqueGroupId(), showPrompt(),
   showConfirm(), showToast(), and touchCurrentTale() as globals
   script.js already defines, and calls back into
   enterPassageEditor() on a plain click. Everything this file owns
   is namespaced under NodeGraph so it isn't adding more bare
   globals on top of the ones already there.

   Groups as an explicit tree, arbitrary depth: unlike the earlier
   version (chapters auto-collapsed by matching text, one level
   only), grouping now lives in its own `story.groups` map —
   {id, label, parentId} — completely decoupled from the reader-
   facing `chapter` field on a passage (see story-data.js/
   tale-storage.js). A group's parentId can point at another group,
   so nesting is just "how deep the parent chain goes" — there's no
   depth limit or special-cased "top vs. scoped" rendering path
   anymore, every level (including the top) is rendered by the same
   recursive machinery, scoped to whatever `scopePath` currently is.

   Interactions:
   - Click a passage              -> open it in the passage editor.
   - Click a group card           -> submerge into that group.
   - Breadcrumb (a full stack,
     one crumb per ancestor)      -> jump back to any ancestor level.
   - "+ New group"                -> creates an empty group at the
                                      current level; it only gains
                                      members when something is
                                      dragged onto it (below).
   - Drag a passage/group card
     onto a group card            -> nests it inside that group
                                      (reparents groupId/parentId).
                                      Dragging a group onto its own
                                      descendant is refused (would
                                      create a cycle).
   - Drag a node elsewhere        -> just repositions it; saved to
                                      gmStory.layout[id] (passages)
                                      or gmStory.groupLayout[id]
                                      (groups); persists.
   - Drag from a node's gold
     connector dot onto
     another node                 -> adds a new choice linking them
                                      (dropped on a group, links to
                                      that group's entry passage,
                                      searched recursively through
                                      its whole subtree).
   - Drag the connector onto
     empty canvas                 -> creates a brand-new passage
                                      where you dropped it, linked,
                                      as a member of the group
                                      currently in view (or ungrouped
                                      at the top level).
   - Double-click empty canvas    -> creates a new, unlinked passage
                                      in the current group scope.
   - Drag empty canvas            -> pans the graph.
   - Mouse wheel                  -> zooms, centered on the cursor.
   - Trackpad two-finger swipe    -> pans.
   - Ctrl/Cmd+scroll              -> zooms (covers trackpad pinch too).
   - Shift+scroll                 -> pans horizontally.
   - Search box                   -> dims non-matching passages/groups
                                      and centers the view on the first
                                      hit (searches inside a group's
                                      whole subtree too, not just its
                                      direct members).
   The page itself never scrolls; all of this happens inside the
   graph via a CSS transform (translate + scale) on the canvas.
   ========================================================= */

const NodeGraph = (() => {
  const NODE_W = 280;
  const NODE_H = 150;
  const CANVAS_PAD = 220;  // buffer on the right/bottom for dangling/external-link stubs AND their text labels (SVG clips anything past its own width)
  const MIN_SCALE = 0.3;
  const MAX_SCALE = 2.5;

  let viewportEl = null;
  let canvasEl = null;
  let wiresSvg = null;
  let liveLayer = null;
  let currentPositions = {};   // key -> {x, y}, canvas-space (pre-transform). Key is a passage id, or a group id.
  let currentDescriptors = {}; // key -> {kind:'passage', passageId} | {kind:'group', key, group, allPassageIds}. allPassageIds is every passage anywhere in that group's subtree, recursively.
  let currentContainerOf = {}; // passageId -> key, at the currently-rendered level only
  let currentContainerId = null; // the group id currently in view, or null at the top level
  let cardEls = {};            // key -> the rendered card element, for drop-target highlighting during drag
  // key -> the card's real rendered height (px, canvas-space), measured
  // right after it's mounted each render. Cards are content-sized now (see
  // buildPassageNode), so NODE_H is only ever a fallback guess for a key
  // that hasn't been measured yet — every geometry function below (wire
  // endpoints, hit-testing, canvas bounds) should read a real height
  // through nodeHeight() rather than assuming NODE_H directly.
  let currentNodeHeights = {};
  let scopePath = [];          // [] = top-level view; otherwise a stack of group ids, deepest last
  let collapsedContentsRows = new Set(); // group ids collapsed in the Contents sidebar tree — sidebar-local UI state, independent of scopePath/canvas scope. Empty = everything expanded (the default).
  let wired = false;           // guards against re-attaching static listeners on every render

  let panX = 40, panY = 40, scale = 1;

  function nodeHeight(key) {
    return currentNodeHeights[key] || NODE_H;
  }

  function ensureLayout(story) {
    if (!story.layout) story.layout = {};
    return story.layout;
  }
  function ensureGroupLayout(story) {
    if (!story.groupLayout) story.groupLayout = {};
    return story.groupLayout;
  }
  function ensureGroups(story) {
    if (!story.groups) story.groups = {};
    return story.groups;
  }

  function applyTransform() {
    canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  function resetView() {
    scale = 1;
    scopePath = [];
  }

  function currentContainer() {
    return scopePath.length ? scopePath[scopePath.length - 1] : null;
  }

  // ---- Group tree -----------------------------------------------

  function directChildGroups(story, containerId) {
    return Object.keys(story.groups).filter(id => (story.groups[id].parentId || null) === containerId);
  }
  function directChildPassages(story, containerId) {
    return Object.keys(story.nodes).filter(id => (story.nodes[id].groupId || null) === containerId);
  }
  // Every passage anywhere under this group, however deep — a group's own
  // stats (and its search haystack) are about its whole subtree, not just
  // whichever passages happen to sit directly inside it.
  function collectDescendantPassageIds(story, groupId) {
    const ids = directChildPassages(story, groupId).slice();
    directChildGroups(story, groupId).forEach(sub => {
      ids.push(...collectDescendantPassageIds(story, sub));
    });
    return ids;
  }
  // True if `candidateId` is `ancestorId` itself, or sits anywhere below it
  // in the tree — used to refuse a drag that would nest a group inside its
  // own descendant (a cycle with no valid "top" to render from).
  function isSelfOrDescendantGroup(story, candidateId, ancestorId) {
    let id = candidateId;
    const seen = new Set();
    while (id && !seen.has(id)) {
      if (id === ancestorId) return true;
      seen.add(id);
      const g = story.groups[id];
      id = g ? (g.parentId || null) : null;
    }
    return false;
  }
  // Top (root) to bottom (this group) chain of labels, for breadcrumb-style
  // "leaves to" wire-stub text — e.g. "Act II › The Vault".
  function groupPathLabel(story, groupId) {
    const chain = [];
    let id = groupId;
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      chain.push(id);
      const g = story.groups[id];
      id = g ? (g.parentId || null) : null;
    }
    return chain.reverse().map(gid => (story.groups[gid] && story.groups[gid].label) || gid).join(" \u203A ");
  }

  function countEntries(story, memberIdSet) {
    let count = 0;
    Object.keys(story.nodes).forEach(id => {
      if (memberIdSet.has(id)) return;
      (story.nodes[id].choices || []).forEach(c => {
        if (c.to && memberIdSet.has(c.to)) count++;
      });
    });
    return count;
  }

  // The passage a submerged view (or a connector dropped on a group card)
  // should treat as "the way in": whichever member is linked to from
  // outside the group's subtree, "start" if it's a member, a member with
  // no incoming link from another member (i.e. the actual root of its
  // internal chain), or — last resort — the first member alphabetically.
  function findGroupEntry(story, memberIds) {
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

  // The single function every level (including the top) renders through:
  // direct-child groups become group cards, direct-child passages become
  // passage cards. No more separate top-level/scoped branches.
  function buildDescriptorsAtLevel(story, containerId) {
    const descriptors = {};
    const containerOf = {};

    directChildGroups(story, containerId).forEach(groupId => {
      const allPassageIds = collectDescendantPassageIds(story, groupId);
      descriptors[groupId] = { kind: "group", key: groupId, group: story.groups[groupId], allPassageIds };
      allPassageIds.forEach(id => { containerOf[id] = groupId; });
    });
    directChildPassages(story, containerId).forEach(id => {
      descriptors[id] = { kind: "passage", passageId: id };
      containerOf[id] = id;
    });

    return { descriptors, containerOf };
  }

  // Resolves which descriptor key at `containerId`'s level represents
  // `passageId` — itself if it's a direct member, or whichever ancestor
  // group sits directly under `containerId` if it's nested deeper. Returns
  // null if the passage isn't anywhere under containerId at all (it's
  // either above the current scope, or off in an unrelated branch) — the
  // caller treats that as "leaves this view" rather than drawing a wire.
  function keyAtLevel(story, passageId, containerId) {
    const node = story.nodes[passageId];
    if (!node) return null;
    let key = passageId;
    let parentId = node.groupId || null;
    while (parentId !== containerId) {
      if (parentId === null) return null;
      key = parentId;
      const g = story.groups[parentId];
      if (!g) return null;
      parentId = g.parentId || null;
    }
    return key;
  }

  // ---- Layout (auto-position fallback for anything without a saved spot) ----

  function outgoingKeysAtLevel(story, descriptors, containerOf, key) {
    const desc = descriptors[key];
    const memberIds = desc.kind === "group" ? desc.allPassageIds : [desc.passageId];
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

  // BFS from whichever descriptor holds "start" (if any are in view at
  // this level) gives every group/passage a sensible default column
  // (depth) and row. Same shortest-path idea at every level — there's no
  // separate "top" vs. "scoped" auto-layout anymore.
  function autoPositionsAtLevel(story, descriptors, containerOf) {
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
        outgoingKeysAtLevel(story, descriptors, containerOf, key).forEach(t => {
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

  function resolvePositionsAtLevel(story, descriptors, containerOf) {
    const layout = ensureLayout(story);
    const groupLayout = ensureGroupLayout(story);
    const auto = autoPositionsAtLevel(story, descriptors, containerOf);
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

  // ---- Geometry (shared by every level — agnostic to what a "key" is) ----

  function edgePoint(pos, side, height) {
    const h = height || NODE_H;
    switch (side) {
      case "top": return { x: pos.x + NODE_W / 2, y: pos.y };
      case "bottom": return { x: pos.x + NODE_W / 2, y: pos.y + h };
      case "left": return { x: pos.x, y: pos.y + h / 2 };
      case "right":
      default: return { x: pos.x + NODE_W, y: pos.y + h / 2 };
    }
  }

  // Omnidirectional auto-routing: rather than storing which side a wire
  // uses (a data-model change), the side pair is recomputed fresh every
  // render from wherever the two cards currently sit — using each card's
  // real measured height (fromH/toH), not NODE_H, since cards are
  // content-sized and vary. Whichever axis has the bigger gap between
  // their centers wins — a target mostly to the side connects left/right,
  // a target mostly above/below connects top/bottom — so dragging a card
  // around re-routes its wires for free instead of leaving them pinned to
  // a side that no longer makes sense.
  function pickSides(fromPos, toPos, fromH, toH) {
    const fh = fromH || NODE_H, th = toH || NODE_H;
    const fromCenter = { x: fromPos.x + NODE_W / 2, y: fromPos.y + fh / 2 };
    const toCenter = { x: toPos.x + NODE_W / 2, y: toPos.y + th / 2 };
    const dx = toCenter.x - fromCenter.x;
    const dy = toCenter.y - fromCenter.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0
        ? { sourceSide: "right", targetSide: "left", orientation: "horizontal" }
        : { sourceSide: "left", targetSide: "right", orientation: "horizontal" };
    }
    return dy >= 0
      ? { sourceSide: "bottom", targetSide: "top", orientation: "vertical" }
      : { sourceSide: "top", targetSide: "bottom", orientation: "vertical" };
  }

  function wirePath(from, to, orientation) {
    if (orientation === "vertical") {
      const dy = Math.max(40, Math.abs(to.y - from.y) / 2);
      const sign = to.y >= from.y ? 1 : -1;
      return `M ${from.x} ${from.y} C ${from.x} ${from.y + dy * sign}, ${to.x} ${to.y - dy * sign}, ${to.x} ${to.y}`;
    }
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
  // icon vocabulary the rest of the app doesn't have. The trailing
  // kebab/chevron used to live here (opts.chevron) — it's now a sibling
  // of the whole card instead (see buildCardMenu), positioned against the
  // card's own vertical center rather than this row specifically, so it
  // stops being this function's concern.
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

  // A small line-art "location" icon — a shield/badge outline containing
  // either one house silhouette (a plain passage) or two overlapping ones
  // (a group), echoing the same "stacked = more than one" idea as the
  // group card's own layered shell below. Built as real inline SVG rather
  // than a clip-path span like the old crown/skull attempt: those turned
  // out blurry/malformed at this render size (too many close-together
  // points for clip-path's anti-aliasing to hold up), where real SVG
  // paths/polygons stay crisp. Every kind now uses this same technique.
  function buildLocationIcon(kind) {
    const wrap = document.createElement("span");
    wrap.className = "graph-node-icon icon-" + kind;
    wrap.setAttribute("aria-hidden", "true");
    const houses = kind === "group"
      ? '<g opacity="0.55"><polygon points="7.6,6.6 9.6,4.8 11.6,6.6"/><rect x="8.1" y="6.5" width="3" height="2.8"/></g>' +
        '<polygon points="4.6,9.4 7,7.1 9.4,9.4"/><rect x="5.1" y="9.3" width="3.8" height="3.4"/>'
      : '<polygon points="5.6,8.4 8,6.1 10.4,8.4"/><rect x="6.1" y="8.3" width="3.8" height="3.6"/>';
    wrap.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M8 1.2 L13.4 3.6 V8.2 C13.4 11.5 10.8 13.6 8 14.6 C5.2 13.6 2.6 11.5 2.6 8.2 V3.6 Z" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/>' +
        '<g fill="currentColor">' + houses + '</g>' +
      '</svg>';
    return wrap;
  }

  // Crown (start) and skull (ending) — a single flat silhouette polygon
  // for the crown (five peaks, center tallest, matching the reference art
  // directly), and a simple domed-cranium path with two punched-out eye
  // sockets for the skull. No filters/drop-shadows on either — those were
  // part of what made the old clip-path version look muddy at ~16-19px.
  // baseClass lets this serve both the map cards (graph-node-icon) and
  // the Contents sidebar (gm-contents-icon), which sit at different sizes
  // but want the exact same two shapes.
  function buildEmblemIcon(kind, baseClass) {
    const wrap = document.createElement("span");
    wrap.className = (baseClass || "graph-node-icon") + " icon-" + kind;
    wrap.setAttribute("aria-hidden", "true");
    wrap.innerHTML = kind === "start"
      ? '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
          '<polygon points="2,13 2,4 3.5,8 5,4 6.5,8 8,2.5 9.5,8 11,4 12.5,8 14,4 14,13" fill="currentColor"/>' +
        '</svg>'
      : '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">' +
          '<path d="M8 1.4 C11.3 1.4 13.6 3.9 13.6 7.1 C13.6 9.3 12.5 10.7 11.3 11.4 V13 C11.3 13.4 11 13.7 10.6 13.7 H9.3 V14.8 C9.3 15.1 9 15.4 8.7 15.4 H7.3 C7 15.4 6.7 15.1 6.7 14.8 V13.7 H5.4 C5 13.7 4.7 13.4 4.7 13 V11.4 C3.5 10.7 2.4 9.3 2.4 7.1 C2.4 3.9 4.7 1.4 8 1.4 Z" fill="currentColor"/>' +
          '<circle cx="5.6" cy="7.2" r="1.3" style="fill:var(--surface-raised)"/>' +
          '<circle cx="10.4" cy="7.2" r="1.3" style="fill:var(--surface-raised)"/>' +
        '</svg>';
    return wrap;
  }

  // Icon + title, side by side — shared shape between passage and group
  // cards so the two read as the same card family at a glance. All four
  // kinds are real inline SVG now (see buildLocationIcon/buildEmblemIcon
  // above) — nothing left drawing itself purely in CSS.
  function buildNodeHead(kind, titleText) {
    const head = document.createElement("div");
    head.className = "graph-node-head";

    const isLocation = kind === "normal" || kind === "group";
    head.appendChild(isLocation ? buildLocationIcon(kind) : buildEmblemIcon(kind));

    const title = document.createElement("span");
    title.className = "graph-node-title";
    title.textContent = titleText;
    head.appendChild(title);

    return head;
  }

  // The trailing indicator pinned to a card's right edge, vertically
  // centered against the *card* rather than any one row inside it (that's
  // deliberate — see the comment on buildMetaBar above). A passage gets a
  // kebab (decorative only for now, no menu wired up behind it yet); a
  // group gets the "expand" chevron the stacked layered shell doesn't
  // otherwise make explicit.
  function buildCardMenu(kind) {
    const menu = document.createElement("span");
    menu.setAttribute("aria-hidden", "true");
    if (kind === "group") {
      menu.className = "graph-node-menu is-chevron";
      menu.textContent = "\u2304"; // ⌄
    } else {
      menu.className = "graph-node-menu is-kebab";
      for (let i = 0; i < 3; i++) {
        menu.appendChild(document.createElement("span"));
      }
    }
    return menu;
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

  // Center of the visible viewport, in canvas-space — used to place a
  // brand-new passage or group where the reader is actually looking,
  // rather than off-screen wherever canvas-space (0,0) happens to be.
  function viewportCenterCanvasPoint() {
    const rect = viewportEl ? viewportEl.getBoundingClientRect() : { width: 600, height: 400 };
    return { x: (rect.width / 2 - panX) / scale, y: (rect.height / 2 - panY) / scale };
  }

  function resizeCanvasBounds() {
    let minX = 0, minY = 0, maxX = 300, maxY = 300;
    Object.keys(currentPositions).forEach(key => {
      const p = currentPositions[key];
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      maxY = Math.max(maxY, p.y + nodeHeight(key));
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

  // Every wire (solid, dangling, external) ends in a plain dot at both the
  // source and destination — no directional arrowhead. A dot at each end
  // reads as "these two things are connected" without needing to also
  // convey direction visually; the choice's own label (read in the
  // passage editor) is what actually tells you which way a link runs.
  function drawSolidWire(from, to, orientation) {
    wiresSvg.appendChild(svgEl("path", { d: wirePath(from, to, orientation), class: "graph-wire" }));
    wiresSvg.appendChild(svgEl("circle", { cx: from.x, cy: from.y, r: 5, class: "graph-dot" }));
    wiresSvg.appendChild(svgEl("circle", { cx: to.x, cy: to.y, r: 5, class: "graph-dot" }));
  }

  function drawStub(from, cssClass, labelText) {
    const stub = { x: from.x + 70, y: Math.max(16, from.y - 60) };
    wiresSvg.appendChild(svgEl("path", { d: wirePath(from, stub), class: "graph-wire " + cssClass }));
    wiresSvg.appendChild(svgEl("circle", { cx: from.x, cy: from.y, r: 5, class: "graph-dot" }));
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

  // One function for every level (including the top): a choice's target is
  // either inside the current view (drawn solid, possibly to an ancestor
  // group card representing a deeper nested passage), broken (red stub),
  // or valid but out of view right now — gold stub, labelled with its full
  // group path so it reads as "leaves to Act II › The Vault" rather than
  // just a bare, context-free passage id.
  function buildWiresAtLevel(story, containerId, descriptors, positions) {
    const drawn = new Set();
    Object.keys(descriptors).forEach(key => {
      const desc = descriptors[key];
      const memberIds = desc.kind === "group" ? desc.allPassageIds : [desc.passageId];
      const fromPos = positions[key];
      if (!fromPos) return;
      const fromH = nodeHeight(key);
      // Used only for dangling/external stubs, where there's no real target
      // position to route toward — solid wires (below) pick their own side
      // per-target instead of reusing this.
      const fallbackFrom = edgePoint(fromPos, "right", fromH);

      memberIds.forEach(id => {
        (story.nodes[id].choices || []).forEach(choice => {
          if (!choice.to) return;

          if (!story.nodes[choice.to]) {
            const dedupe = key + "\u2192!" + choice.to;
            if (drawn.has(dedupe)) return;
            drawn.add(dedupe);
            drawDanglingStub(fallbackFrom, choice.to);
            return;
          }

          const targetKey = keyAtLevel(story, choice.to, containerId);
          if (targetKey === key) return; // internal to this same card, not shown at this level

          if (targetKey) {
            const dedupe = key + "\u2192" + targetKey;
            if (drawn.has(dedupe)) return;
            drawn.add(dedupe);
            const toPos = positions[targetKey];
            const toH = nodeHeight(targetKey);
            const sides = pickSides(fromPos, toPos, fromH, toH);
            drawSolidWire(edgePoint(fromPos, sides.sourceSide, fromH), edgePoint(toPos, sides.targetSide, toH), sides.orientation);
            return;
          }

          const dedupe = key + "\u2192!ext!" + choice.to;
          if (drawn.has(dedupe)) return;
          drawn.add(dedupe);
          const targetGroupId = story.nodes[choice.to].groupId || null;
          const label = targetGroupId ? groupPathLabel(story, targetGroupId) : choice.to;
          drawStub(fallbackFrom, "external", "leaves to \u2192 " + label);
        });
      });
    });
  }

  function redrawCurrentWires() {
    wiresSvg.innerHTML = "";
    buildWiresAtLevel(gmStory, currentContainerId, currentDescriptors, currentPositions);
  }

  // ---- Drag / connect interactions -------------------------------------

  // Finds a group card (at the current level) whose bounds contain the
  // dragged card's center point — the drop target that would nest the
  // dragged passage/group into it. A group can never be dropped onto
  // itself or one of its own descendants (that'd be a cycle with no valid
  // root to render from).
  function findNestTargetUnder(draggedKey, x, y) {
    const cx = x + NODE_W / 2, cy = y + nodeHeight(draggedKey) / 2;
    let found = null;
    Object.keys(currentDescriptors).forEach(key => {
      if (key === draggedKey || found) return;
      const desc = currentDescriptors[key];
      if (desc.kind !== "group") return;
      const pos = currentPositions[key];
      if (!pos) return;
      const h = nodeHeight(key);
      if (cx < pos.x || cx > pos.x + NODE_W || cy < pos.y || cy > pos.y + h) return;
      const draggedDesc = currentDescriptors[draggedKey];
      if (draggedDesc.kind === "group" && isSelfOrDescendantGroup(gmStory, key, draggedKey)) return;
      found = key;
    });
    return found;
  }

  function clearDropTargetHighlight() {
    Object.values(cardEls).forEach(el => el && el.classList.remove("drop-target"));
  }

  function attachDrag(card, key, onCommitPosition, onPlainClick) {
    const THRESH = 4;
    card.addEventListener("pointerdown", e => {
      if (e.target.closest(".graph-connector") || e.target.closest(".graph-node-group-action") || e.button !== 0) return;
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

        const targetKey = findNestTargetUnder(key, nx, ny);
        clearDropTargetHighlight();
        const desc = currentDescriptors[key];
        const canNest = !(desc.kind !== "group" && desc.passageId === "start");
        if (targetKey && canNest && cardEls[targetKey]) cardEls[targetKey].classList.add("drop-target");
      }
      function onUp() {
        card.releasePointerCapture(e.pointerId);
        card.removeEventListener("pointermove", onMove);
        card.removeEventListener("pointerup", onUp);
        card.classList.remove("dragging");
        clearDropTargetHighlight();

        if (!dragging) { onPlainClick(); return; }

        const targetKey = findNestTargetUnder(key, currentPositions[key].x, currentPositions[key].y);
        const desc = currentDescriptors[key];

        // The start passage is the one thing on the map that can never be
        // nested — the engine looks it up by id at the top level of the
        // story, not by walking the group tree, so a grouped "start" would
        // quietly become unreachable. Treated the same as "no target under
        // the drop point": the card just settles at its new position.
        if (targetKey && desc.kind !== "group" && desc.passageId === "start") {
          showToast("The start passage can\u2019t be moved into a group.");
          onCommitPosition({ ...currentPositions[key] });
          touchCurrentTale();
          return;
        }

        if (targetKey) {
          if (desc.kind === "group") {
            gmStory.groups[key].parentId = targetKey;
          } else {
            gmStory.nodes[desc.passageId].groupId = targetKey;
          }
          touchCurrentTale();
          showToast("Moved into \u201c" + gmStory.groups[targetKey].label + "\u201d.");
          render();
          return;
        }

        onCommitPosition({ ...currentPositions[key] });
        touchCurrentTale();
      }
      card.addEventListener("pointermove", onMove);
      card.addEventListener("pointerup", onUp);
    });
  }

  // The zone (not the dot) is the real interactive target — see the CSS
  // comment on .graph-connector for why: the dot is revealed by :hover on
  // this zone, so if the dot itself ever captured pointer events, revealing
  // it would immediately occlude the very zone that's keeping it revealed,
  // and the two would fight over "who's hovered" every single frame.
  // `dot` is passed through only so this can toggle its visual state
  // (.active-drag) and read its position for the wire's anchor point.
  function attachConnectorDrag(zone, dot, sourceId, side) {
    zone.addEventListener("pointerdown", e => {
      e.stopPropagation();
      e.preventDefault();
      zone.setPointerCapture(e.pointerId);
      const sourceCard = zone.closest(".graph-node");
      if (sourceCard) sourceCard.classList.add("connecting");
      dot.classList.add("active-drag"); // keeps just this one dot visible once the cursor leaves its hover strip mid-drag
      const from = edgePoint(currentPositions[sourceId], side, nodeHeight(sourceId));
      // The live preview line's curve matches whichever side you actually
      // grabbed — pull from the top dot and it arcs upward first, pull from
      // the right dot and it arcs sideways first — rather than always
      // bending horizontally regardless of where the drag started.
      const orientation = (side === "top" || side === "bottom") ? "vertical" : "horizontal";
      const temp = svgEl("path", { class: "graph-wire temp" });
      liveLayer.appendChild(temp);

      function onMove(ev) {
        temp.setAttribute("d", wirePath(from, toCanvasPoint(ev.clientX, ev.clientY), orientation));
      }

      async function onUp(ev) {
        zone.releasePointerCapture(e.pointerId);
        zone.removeEventListener("pointermove", onMove);
        zone.removeEventListener("pointerup", onUp);
        temp.remove();
        if (sourceCard) sourceCard.classList.remove("connecting");
        dot.classList.remove("active-drag");

        const under = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetCard = under && under.closest(".graph-node");
        let targetId = targetCard && targetCard.dataset.nodeId;
        if (!targetId && targetCard && targetCard.dataset.nodeKey) {
          // Dropped on a group card — link to that group's entry passage
          // (searched across its whole subtree, not just direct members).
          const desc = currentDescriptors[targetCard.dataset.nodeKey];
          if (desc && desc.kind === "group") targetId = findGroupEntry(gmStory, desc.allPassageIds);
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
        // as a member of whichever group is currently in view.
        const raw = await showPrompt("Id for the new passage this connects to (letters and numbers only):");
        if (raw === null || !raw.trim()) return;
        const newId = slugify(raw) || ("passage" + Date.now());
        if (gmStory.nodes[newId]) { showToast("A passage with that id already exists."); return; }
        const label = await showPrompt("Choice text for this link:", "");
        if (label === null) return;

        const p = toCanvasPoint(ev.clientX, ev.clientY);
        gmStory.nodes[newId] = { chapter: "", groupId: currentContainer(), text: "", choices: [] };
        ensureLayout(gmStory)[newId] = { x: Math.max(0, p.x - NODE_W / 2), y: Math.max(0, p.y - NODE_H / 2) };
        gmStory.nodes[sourceId].choices = gmStory.nodes[sourceId].choices || [];
        gmStory.nodes[sourceId].choices.push({ label: label.trim() || "Continue", to: newId });
        touchCurrentTale();
        render();
      }
      zone.addEventListener("pointermove", onMove);
      zone.addEventListener("pointerup", onUp);
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
    // Height is no longer pinned to NODE_H — cards size to their content now
    // (see .graph-node in style.css). The real rendered height is measured
    // right after render() mounts every card, and every wire/hit-test/bounds
    // calculation reads that measured value (nodeHeight(key)) rather than
    // assuming NODE_H, so wires still land exactly on the edge of whatever
    // height a card actually turns out to be.
    card.tabIndex = 0;

    // The ribbon now marks the start passage only — endings get their own
    // glyph below instead, so the two states read distinctly rather than
    // sharing one corner treatment.
    if (isStart) {
      const ribbon = document.createElement("span");
      ribbon.className = "graph-node-ribbon";
      ribbon.title = "Start passage";
      card.appendChild(ribbon);
    }

    const glyphKind = isStart ? "start" : (node.end ? "ending" : "normal");
    card.appendChild(buildNodeHead(glyphKind, id));
    card.appendChild(buildCardMenu("passage"));

    const hasChapter = node.chapter && node.chapter.trim();
    if (node.end || hasChapter) {
      const sub = document.createElement("span");
      sub.className = "graph-node-sub";
      sub.textContent = node.end ? (node.endingType || "ending") : node.chapter;
      card.appendChild(sub);
    }

    const choices = node.choices || [];
    const stats = node.end
      ? [{ value: "\u2014", label: "choices" }, { value: "\u2014", label: "req." }]
      : [
          { value: choices.length, label: "choices" },
          { value: choices.filter(c => c.requires && c.requires.item).length, label: "req." },
          { value: choices.filter(c => c.grants && c.grants.item).length, label: "grants" }
        ];
    card.appendChild(buildMetaBar(stats));

    // One connector dot per side (N/E/S/W), each revealed only by hovering
    // its own edge — not by hovering the card generally — so it's clear
    // which side you're about to drag from before you've grabbed anything.
    // Each dot gets a matching invisible hover strip along that edge
    // (bigger than the dot itself, since a precise 18px target is hard to
    // find by accident): the strip is a real sibling element rather than
    // just an enlarged hover radius on the dot, because a strip actually
    // covers the *whole* edge, corners included, the way "hover that
    // side" implies.
    ["top", "right", "bottom", "left"].forEach(side => {
      const zone = document.createElement("span");
      zone.className = "graph-node-hover-zone side-" + side;
      zone.title = "Drag to link this passage to another";
      zone.tabIndex = 0; // keyboard users can Tab to a side and reveal its dot too — see the :focus-visible rule on .graph-connector
      card.appendChild(zone);

      const dot = document.createElement("span");
      dot.className = "graph-connector side-" + side;
      dot.setAttribute("aria-hidden", "true"); // decorative only now — the zone is the real, labeled interactive target
      card.appendChild(dot);
      attachConnectorDrag(zone, dot, id, side);
    });

    attachDrag(card, id, pos2 => { ensureLayout(gmStory)[id] = pos2; }, () => enterPassageEditor(id));
    return card;
  }

  function buildGroupNode(desc, pos, reachable) {
    const memberReachable = desc.allPassageIds.some(id => reachable.has(id));
    const subgroupCount = directChildGroups(gmStory, desc.key).length;

    const card = document.createElement("div");
    card.className = "graph-node graph-node-group" + (!memberReachable ? " is-orphan" : "");
    card.dataset.nodeKey = desc.key;
    card.style.left = pos.x + "px";
    card.style.top = pos.y + "px";
    card.style.width = NODE_W + "px";
    // See the matching note in buildPassageNode — height now follows content.
    card.tabIndex = 0;
    card.title = "Open this group";

    const actions = document.createElement("div");
    actions.className = "graph-node-group-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "graph-node-group-action";
    renameBtn.title = "Rename this group";
    renameBtn.textContent = "\u270E";
    renameBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const raw = await showPrompt("Rename this group:", desc.group.label);
      if (raw === null || !raw.trim()) return;
      desc.group.label = raw.trim();
      touchCurrentTale();
      render();
    });
    actions.appendChild(renameBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "graph-node-group-action danger";
    deleteBtn.title = "Delete this group";
    deleteBtn.textContent = "\u2715";
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteGroup(desc.key);
    });
    actions.appendChild(deleteBtn);
    card.appendChild(actions);

    card.appendChild(buildNodeHead("group", desc.group.label));

    const sub = document.createElement("span");
    sub.className = "graph-node-sub";
    sub.textContent = subgroupCount > 0 ? subgroupCount + " subgroup" + (subgroupCount === 1 ? "" : "s") : "group";
    card.appendChild(sub);

    const entries = countEntries(gmStory, new Set(desc.allPassageIds));
    card.appendChild(buildMetaBar([
      { value: desc.allPassageIds.length, label: "passages" },
      { value: entries, label: entries === 1 ? "entry" : "entries" }
    ]));
    card.appendChild(buildCardMenu("group"));

    attachDrag(
      card, desc.key,
      pos2 => { ensureGroupLayout(gmStory)[desc.key] = pos2; },
      () => submergeInto(desc.key)
    );
    return card;
  }

  // ---- Group lifecycle ---------------------------------------------------

  async function deleteGroup(groupId) {
    const group = gmStory.groups[groupId];
    if (!group) return;
    const childGroups = directChildGroups(gmStory, groupId);
    const childPassages = directChildPassages(gmStory, groupId);
    const totalPassages = collectDescendantPassageIds(gmStory, groupId).length;

    const parts = [];
    if (totalPassages) parts.push(totalPassages + " passage" + (totalPassages === 1 ? "" : "s"));
    if (childGroups.length) parts.push(childGroups.length + " subgroup" + (childGroups.length === 1 ? "" : "s"));
    const destination = group.parentId && gmStory.groups[group.parentId]
      ? "\u201c" + gmStory.groups[group.parentId].label + "\u201d"
      : "the top level";
    const contentsNote = parts.length ? " Its " + parts.join(" and ") + " will move up to " + destination + "." : "";

    const ok = await showConfirm("Delete the group \u201c" + group.label + "\u201d?" + contentsNote);
    if (!ok) return;

    childGroups.forEach(id => { gmStory.groups[id].parentId = group.parentId || null; });
    childPassages.forEach(id => { gmStory.nodes[id].groupId = group.parentId || null; });
    delete gmStory.groups[groupId];
    if (gmStory.groupLayout) delete gmStory.groupLayout[groupId];

    // If we were scoped inside the deleted group (or one of its now-
    // reparented descendants), pop back out to wherever it used to live —
    // the map never renders a scope path pointing at nothing.
    const idx = scopePath.indexOf(groupId);
    if (idx !== -1) scopePath = scopePath.slice(0, idx);

    touchCurrentTale();
    showToast("Group deleted \u2014 its contents moved up.");
    render();
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
    const cx = pos.x + NODE_W / 2, cy = pos.y + nodeHeight(key) / 2;
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
      maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + nodeHeight(key));
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
        haystack = (desc.group.label + " " + desc.allPassageIds.map(id =>
          id + " " + (gmStory.nodes[id].text || "")).join(" ")).toLowerCase();
      }
      const match = !q || haystack.includes(q);
      card.classList.toggle("is-dimmed", !!q && !match);
      if (q && match && firstMatchKey === null) firstMatchKey = key;
    });
    if (q && firstMatchKey) focusOnKey(firstMatchKey);
  }

  // ---- Navigation ---------------------------------------------------------

  function submergeInto(groupId) {
    scopePath = scopePath.concat([groupId]);
    render();
  }

  function updateBreadcrumb() {
    const bar = document.getElementById("gm-map-breadcrumb");
    if (!bar) return;
    bar.hidden = scopePath.length === 0;
    if (scopePath.length === 0) return;

    bar.innerHTML = "";

    const topCrumb = document.createElement("button");
    topCrumb.type = "button";
    topCrumb.className = "btn-tiny gm-crumb";
    topCrumb.textContent = "Top";
    topCrumb.addEventListener("click", () => { scopePath = []; render(); });
    bar.appendChild(topCrumb);

    scopePath.forEach((groupId, i) => {
      const sep = document.createElement("span");
      sep.className = "gm-crumb-sep";
      sep.setAttribute("aria-hidden", "true");
      sep.textContent = "\u203A";
      bar.appendChild(sep);

      const group = gmStory.groups[groupId];
      const label = group ? group.label : groupId;
      const isLast = i === scopePath.length - 1;

      if (isLast) {
        const current = document.createElement("span");
        current.className = "gm-crumb gm-crumb-current";
        current.textContent = label;
        bar.appendChild(current);
      } else {
        const crumb = document.createElement("button");
        crumb.type = "button";
        crumb.className = "btn-tiny gm-crumb";
        crumb.textContent = label;
        crumb.addEventListener("click", () => { scopePath = scopePath.slice(0, i + 1); render(); });
        bar.appendChild(crumb);
      }
    });
  }

  // ---- Contents sidebar: a full tree, independent of canvas scope ---------
  // Unlike the canvas (which only ever shows one level's worth of cards at
  // a time via scopePath), this renders the whole group/passage tree at
  // once — a second way to find and open a passage besides drilling into
  // it on the map. Its own expand/collapse state (collapsedContentsRows)
  // is deliberately separate from scopePath: collapsing a row here doesn't
  // change what the canvas has in view, and vice versa.
  function buildContentsLevel(story, containerId) {
    const list = document.createElement("ul");
    list.className = "gm-contents-list";

    directChildGroups(story, containerId).forEach(groupId => {
      const group = story.groups[groupId];
      const isCollapsed = collapsedContentsRows.has(groupId);

      const item = document.createElement("li");
      item.className = "gm-contents-group";

      const row = document.createElement("button");
      row.type = "button";
      row.className = "gm-contents-row gm-contents-group-row";
      row.title = "Collapse/expand — the map's own current view is unaffected";

      const chevron = document.createElement("span");
      chevron.className = "gm-contents-chevron" + (isCollapsed ? "" : " open");
      chevron.textContent = "\u25B8";
      chevron.setAttribute("aria-hidden", "true");
      row.appendChild(chevron);

      // Folder-tab icon, built purely in CSS (see .icon-group) — no glyph
      // character needed here.
      const icon = document.createElement("span");
      icon.className = "gm-contents-icon icon-group";
      icon.setAttribute("aria-hidden", "true");
      row.appendChild(icon);

      const label = document.createElement("span");
      label.className = "gm-contents-label";
      label.textContent = group.label;
      row.appendChild(label);

      row.addEventListener("click", () => {
        if (isCollapsed) collapsedContentsRows.delete(groupId); else collapsedContentsRows.add(groupId);
        renderContentsSidebar();
      });
      item.appendChild(row);

      if (!isCollapsed) item.appendChild(buildContentsLevel(story, groupId));
      list.appendChild(item);
    });

    directChildPassages(story, containerId).forEach(id => {
      const node = story.nodes[id];
      const isOpenInDrawer = id === gmSelectedNodeId && gmPage && !gmPage.hidden;

      const item = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "gm-contents-row gm-contents-passage-row" + (isOpenInDrawer ? " active" : "") + (node.end ? " is-ending" : "");
      row.title = id;

      // Crown for the start passage, skull for an ending — same inline-SVG
      // shapes the map cards use (see buildEmblemIcon), just sized down
      // for this sidebar. Bullseye for everything else.
      const kind = id === "start" ? "start" : (node.end ? "ending" : "normal");
      let icon;
      if (kind === "start" || kind === "ending") {
        icon = buildEmblemIcon(kind, "gm-contents-icon");
      } else {
        icon = document.createElement("span");
        icon.className = "gm-contents-icon icon-normal";
        icon.textContent = "\u25CE"; // ◎ bullseye
        icon.setAttribute("aria-hidden", "true");
      }
      row.appendChild(icon);

      const label = document.createElement("span");
      label.className = "gm-contents-label";
      label.textContent = node.chapter && node.chapter.trim() ? node.chapter.trim() : id;
      row.appendChild(label);

      row.addEventListener("click", () => enterPassageEditor(id));
      item.appendChild(row);
      list.appendChild(item);
    });

    return list;
  }

  function renderContentsSidebar() {
    const tree = document.getElementById("gm-contents-tree");
    if (!tree || !gmStory) return;
    tree.innerHTML = "";
    tree.appendChild(buildContentsLevel(gmStory, null));
  }

  function updateStatusbarCounts() {
    const el = document.getElementById("gm-map-statusbar-counts");
    if (!el || !gmStory) return;
    const passageCount = Object.keys(gmStory.nodes).length;
    const groupCount = Object.keys(gmStory.groups).length;
    el.textContent = passageCount + " passage" + (passageCount === 1 ? "" : "s") +
      " \u00B7 " + groupCount + " group" + (groupCount === 1 ? "" : "s");
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
      gmStory.nodes[id] = { chapter: "", groupId: currentContainer(), text: "", choices: [] };
      ensureLayout(gmStory)[id] = { x: Math.max(0, p.x - NODE_W / 2), y: Math.max(0, p.y - NODE_H / 2) };
      touchCurrentTale();
      render();
    });

    document.getElementById("gm-map-new-group").addEventListener("click", async () => {
      const raw = await showPrompt("Name this group (e.g. \u201cAct II \u2014 The Vault\u201d):");
      if (raw === null || !raw.trim()) return;
      const id = uniqueGroupId(gmStory, raw.trim());
      ensureGroups(gmStory)[id] = { id, label: raw.trim(), parentId: currentContainer() };
      const p = viewportCenterCanvasPoint();
      ensureGroupLayout(gmStory)[id] = { x: Math.max(0, p.x - NODE_W / 2), y: Math.max(0, p.y - NODE_H / 2) };
      touchCurrentTale();
      showToast("Group created \u2014 drag passages or other groups onto it to add members.");
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

    const sidebarToggleBtn = document.getElementById("gm-map-sidebar-toggle");
    const mapBody = document.getElementById("gm-map-body");
    if (sidebarToggleBtn && mapBody) {
      sidebarToggleBtn.addEventListener("click", () => {
        const nowHidden = mapBody.classList.toggle("sidebar-hidden");
        sidebarToggleBtn.textContent = nowHidden ? "Show Contents" : "Hide Contents";
      });
    }
  }

  // Used by the map toolbar's "+ New passage" button: places the node at
  // the current center of the visible viewport (accounting for pan/zoom),
  // rather than the reader having to hunt for an off-screen passage.
  function placeNewNode(id) {
    const p = viewportCenterCanvasPoint();
    ensureLayout(gmStory)[id] = { x: Math.max(0, p.x - NODE_W / 2), y: Math.max(0, p.y - NODE_H / 2) };
  }

  function render(opts) {
    viewportEl = document.getElementById("graph-viewport");
    canvasEl = document.getElementById("graph-canvas");
    if (!viewportEl || !canvasEl || !gmStory) return;
    if (opts && opts.resetView) resetView();
    attachStaticListenersOnce();
    ensureGroups(gmStory);

    // A scope path pointing at a group that's been deleted out from under
    // it has nothing left to show — pop back toward the top rather than
    // rendering an empty canvas with no way out.
    while (scopePath.length && !gmStory.groups[scopePath[scopePath.length - 1]]) {
      scopePath.pop();
    }
    currentContainerId = currentContainer();

    canvasEl.innerHTML = "";
    const { reachable } = analyzeStoryFlow(gmStory);

    wiresSvg = svgEl("svg", { class: "graph-wires" });
    liveLayer = svgEl("svg", { class: "graph-live-layer" });
    canvasEl.appendChild(wiresSvg);
    canvasEl.appendChild(liveLayer);

    const { descriptors, containerOf } = buildDescriptorsAtLevel(gmStory, currentContainerId);
    currentDescriptors = descriptors;
    currentContainerOf = containerOf;
    currentPositions = resolvePositionsAtLevel(gmStory, descriptors, containerOf);

    // Cards are built and mounted *before* any wire/bounds geometry runs.
    // They're content-sized now (see buildPassageNode/buildGroupNode), so
    // their real height isn't known until they actually exist in the DOM —
    // measuring them here, before resizeCanvasBounds()/redrawCurrentWires(),
    // is what lets edgePoint() etc. use a real height instead of guessing
    // NODE_H, which is what used to leave wires floating short of (or past)
    // the actual card edge whenever a card's real height differed from it.
    cardEls = {};
    Object.keys(currentPositions).forEach(key => {
      const desc = descriptors[key];
      const card = desc.kind === "group"
        ? buildGroupNode(desc, currentPositions[key], reachable)
        : buildPassageNode(desc.passageId, currentPositions[key], reachable);
      cardEls[key] = card;
      canvasEl.appendChild(card);
    });
    currentNodeHeights = {};
    Object.keys(cardEls).forEach(key => {
      currentNodeHeights[key] = cardEls[key].offsetHeight || NODE_H;
    });

    resizeCanvasBounds();
    redrawCurrentWires();
    applyTransform();

    updateBreadcrumb();
    renderContentsSidebar();
    updateStatusbarCounts();
    if (opts && opts.resetView) fitView();
  }

  return { render, placeNewNode, fitView, currentContainer, groupPathLabel, renderContentsSidebar };
})();