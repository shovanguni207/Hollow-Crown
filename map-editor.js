/* =========================================================
   MapEditor — a geographic/world map of a tale's locations,
   distinct from NodeGraph's map of passage *structure*: this
   one is about where things are, NodeGraph's is about how
   passages connect. Locations are expected to reference
   passages (gmStory.nodes) the same way quests will.

   Stub only, for now — see quest-editor.js's header comment,
   which explains the same reasoning: a render() entry point
   for the "World Map" tab (setGmView() in grimoire-manager.js)
   to call into, no-op-safe on repeat calls, with the real data
   model and canvas built later. #map-editor-viewport's
   placeholder markup in index.html is the whole UI for now.

   Kept separate from graph.js for the same reason quest-editor.js
   is kept separate: this will grow into its own self-contained
   subsystem (location pins, travel connections, its own drag/
   pan/zoom) and shouldn't tangle its diffs with the passage
   graph's. Loaded after graph.js in index.html.
   ========================================================= */

const MapEditor = (function () {

  function render() {
    // Nothing to build yet — #map-editor-viewport's placeholder content in
    // index.html is the whole UI for now. Once there's a real location data
    // model (likely gmStory.locations, alongside gmStory.items/nodes/groups),
    // this is where it gets read and drawn.
  }

  return { render };
})();
