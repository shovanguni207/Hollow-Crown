/* =========================================================
   TALE STORAGE — persistence and data-shape helpers for the
   Grimoire's library of tales. No DOM here: this is the data
   layer that grimoire-manager.js and grimoire-editor.js build on.
   ========================================================= */

const TALES_KEY = "hollow-crown-tales";
const LEGACY_GM_KEY = "hollow-crown-gm-story"; // single-tale format from an earlier version

function starterStory() {
  return {
    items: {},
    quests: {}, // questId -> {id, title, description, objectives: [{id, text, conditions:[{type, target}]}]}
    layout: {}, // nodeId -> {x, y}, manually-dragged positions on the story map
    groupLayout: {}, // groupId -> {x, y}, positions for group nodes on the map
    groups: {}, // groupId -> {id, label, parentId}, the map-organization tree (arbitrary depth, independent of chapter)
    nodes: {
      start: {
        chapter: "I — The Beginning",
        text: "Describe the opening scene here. What does the reader see, and what can they do about it?",
        choices: []
      }
    }
  };
}

// Brings an older-format story up to { items, groups, nodes }. Handles two cases:
// - a flat node map with no wrapper at all (earliest single-tale saves)
// - grants that carried their own {item, label} instead of referencing a registry
//
// `groups` (the map-organization tree, see graph.js) is newer than both of
// those: a save from before it existed has no `groups` key at all, which is
// exactly the signal migrateChapterGroups() below uses to run its one-time
// derivation. Once a story has been migrated, `story.groups` exists (even
// if empty) and this never re-derives from `chapter` again — otherwise a
// later manual regroup would get silently overwritten by former chapter
// strings on every reload.
function migrateStoryFormat(story) {
  if (story && story.nodes) {
    if (!story.items) story.items = {};
    if (!story.quests) story.quests = {};
    if (!story.layout) story.layout = {};
    if (!story.groupLayout) story.groupLayout = {};
    if (!story.groups) {
      story.groups = {};
      migrateChapterGroups(story);
    }
    return story;
  }

  const nodes = story || {};
  const items = {};

  Object.keys(nodes).forEach(nodeId => {
    (nodes[nodeId].choices || []).forEach(choice => {
      if (choice.grants && choice.grants.item) {
        const id = choice.grants.item;
        if (!items[id]) items[id] = { label: choice.grants.label || id, description: "" };
        if (choice.grants.label) delete choice.grants.label; // label now lives only in the registry
      }
    });
  });

  const migrated = { items, quests: {}, layout: {}, groupLayout: {}, groups: {}, nodes };
  migrateChapterGroups(migrated);
  return migrated;
}

// One-time only (see migrateStoryFormat above): reproduces the old map
// behavior — chapters shared by 2+ passages used to auto-collapse into a
// map group — as real, explicit `groups` entries, so a tale that already
// had chapters keeps looking the same on the map after upgrading. `chapter`
// itself is left completely untouched; it stays the reader-facing label
// (shown in-game and as the node's map subtitle) and has no further part
// to play in map organization from here on — `node.groupId` does that job
// on its own from this point forward, independent of what `chapter` says.
function migrateChapterGroups(story) {
  const byChapter = {};
  Object.keys(story.nodes).forEach(id => {
    const ch = (story.nodes[id].chapter || "").trim();
    if (!ch) return;
    (byChapter[ch] = byChapter[ch] || []).push(id);
  });

  Object.keys(byChapter).forEach(chapter => {
    // The start passage never gets grouped, even by this one-time
    // migration — same invariant the live map/drawer enforce (see
    // graph.js's drag-to-nest guard and grimoire-editor.js's "Move to
    // group" guard). Filtered out here rather than skipping the whole
    // chapter, so its old chapter-mates still get grouped normally.
    const memberIds = byChapter[chapter].filter(id => id !== "start");
    if (memberIds.length < 2) return; // singletons stay ungrouped, same threshold the old map used
    const groupId = uniqueGroupId(story, chapter);
    story.groups[groupId] = { id: groupId, label: chapter, parentId: null };
    memberIds.forEach(id => { story.nodes[id].groupId = groupId; });
  });
}

function uniqueGroupId(story, label) {
  const base = slugify(label) || "group";
  let id = base, n = 2;
  while (story.groups[id]) { id = base + "-" + n; n++; }
  return id;
}

function loadTales() {
  let loaded = {};
  try {
    const raw = localStorage.getItem(TALES_KEY);
    if (raw) loaded = JSON.parse(raw);
  } catch (e) {}

  if (Object.keys(loaded).length === 0) {
    // migrate a single-tale save from an earlier version of the Grimoire, if present
    try {
      const legacy = localStorage.getItem(LEGACY_GM_KEY);
      if (legacy) {
        const story = migrateStoryFormat(JSON.parse(legacy));
        const id = "tale-" + Date.now().toString(36);
        loaded = { [id]: { id, title: "My first tale", updatedAt: Date.now(), story } };
        localStorage.removeItem(LEGACY_GM_KEY);
        localStorage.setItem(TALES_KEY, JSON.stringify(loaded));
        return loaded;
      }
    } catch (e) {}
    return loaded;
  }

  // bring every stored tale up to the current { items, nodes } shape
  let migratedAny = false;
  Object.keys(loaded).forEach(id => {
    const before = loaded[id].story;
    const after = migrateStoryFormat(before);
    if (after !== before) migratedAny = true;
    loaded[id].story = after;
  });
  if (migratedAny) {
    try { localStorage.setItem(TALES_KEY, JSON.stringify(loaded)); } catch (e) {}
  }

  return loaded;
}

function saveTales() {
  try { localStorage.setItem(TALES_KEY, JSON.stringify(tales)); } catch (e) {}
}

function slugify(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 40);
}

function uniqueTaleId(title) {
  const base = slugify(title) || "tale";
  return base + "-" + Date.now().toString(36);
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
