/* =========================================================
   APP STATE — mutable globals shared across features.

   These are read and written directly by player.js,
   grimoire-manager.js, grimoire-editor.js, grimoire-items.js,
   and graph.js — same as graph.js already does with gmStory
   and touchCurrentTale(). No module system here (ES modules
   are blocked over file://), so this file just has to load
   before anything that touches these.
   ========================================================= */

// ---- Play state: whichever story is currently being read/played ----
let activeStory = DEFAULT_STORY;
let mode = "play"; // "play" | "gm-playtest" | "library-play"

let state = {
  currentNode: "start",
  inventory: [],       // array of item ids
  history: [],          // stack of {currentNode, inventory} snapshots taken before each choice, for "Go back"
  visitedNodes: new Set(["start"]), // every passage id reached this playthrough — for quest "reach-passage" tracking; only ever grows, even across "Go back", since visiting a passage is a fact of the playthrough that back-navigation doesn't erase
  manualMarks: new Set()            // "<questId>:<objectiveId>" keys the reader has manually checked off — persists across "Go back" too, since it's the reader's own action, not something derived from story state
};
// This exact shape also gets built fresh at the start of every real play
// session — see freshPlayState() in player.js, which every entry point
// (title screen, editor playtest, library play) calls instead of each
// writing its own copy of this literal.

/* =========================================================
   GRIMOIRE DATA — a library of many tales, each its own story object.
   Stored as one object keyed by tale id, so the manager can list,
   rename, duplicate, and delete without touching the others.
   ========================================================= */

let tales = loadTales();
let currentTaleId = null;
let gmStory = null;          // always === tales[currentTaleId].story while editing, shape {items, nodes}
let gmSelectedNodeId = "start";
let gmActiveView = "graph"; // "graph" | "quests" | "map" — which of the three tools is on screen; see setGmView() in grimoire-manager.js
let editingChoices = [];
let expandedChoiceIndex = null; // which choice card (if any) is expanded in the accordion
let expandedItemId = null;      // which item definition (if any) is expanded
let expandedQuestId = null;     // which quest card (if any) is expanded, in the Quests view
let gmInspectorSelection = null; // { kind: "quest", id } | { kind: "objective", questId, objectiveId } | null — whatever the Quests-view Inspector panel is currently showing (see quest-editor.js)

// In-progress edits per passage, keyed by node id. Switching passages in the
// sidebar used to always reload from gmStory (the last *saved* state),
// silently discarding anything typed but not yet saved. This keeps an
// in-memory draft per passage so hopping between passages within the editor
// preserves unsaved work — "Save passage" is still what actually persists
// it to gmStory/localStorage, and leaving the editor (openTale/back to the
// library) clears every draft, so nothing survives outside this panel.
let nodeDrafts = {};
let gmEditorLoaded = false; // guards against capturing a bogus draft on the very first selectGmNode() call