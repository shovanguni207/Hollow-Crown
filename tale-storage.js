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
    layout: {}, // nodeId -> {x, y}, manually-dragged positions on the story map
    groupLayout: {}, // "§"+chapter -> {x, y}, positions for chapter-group nodes on the map
    nodes: {
      start: {
        chapter: "I — The Beginning",
        text: "Describe the opening scene here. What does the reader see, and what can they do about it?",
        choices: []
      }
    }
  };
}

// Brings an older-format story up to { items, nodes }. Handles two cases:
// - a flat node map with no wrapper at all (earliest single-tale saves)
// - grants that carried their own {item, label} instead of referencing a registry
function migrateStoryFormat(story) {
  if (story && story.nodes) {
    if (!story.items) story.items = {};
    if (!story.layout) story.layout = {};
    if (!story.groupLayout) story.groupLayout = {};
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

  return { items, layout: {}, groupLayout: {}, nodes };
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
