# Hollow-Crown
A CYOA Engine

**The Hollow Crown**

A fantasy Choose Your Own Adventure engine with a built-in authoring tool (the Grimoire) for writing, editing, and playtesting branching tales. Vanilla HTML/CSS/JS no build step, no dependencies, no backend.

**Features**

Grimoire (authoring tool)

1.Multi-tale library manager (open, rename, duplicate, export, delete).

2.Passage editor with accordion-style choice cards.

3.Item registry with autocomplete for requirements/grants.

4.Live playtesting from within the editor.

5.JSON import/export per tale.

6.Backward-compatible migration for older save data.

**Usage**

1.Play the built-in tale directly from the main screen.

2.Write your own: open the Grimoire from the main menu, create a new tale, and add passages. Each passage can define choices that link to other passages
optionally requiring or granting inventory items.

3.Playtest a tale in progress at any point from within the Grimoire.

4.Export a tale to a `.json` file to back it up or share it; import a `.json` file to load one back in.

**Data Model**

Each tale is a node graph. A passage looks like this:

```json { "chapter": "I — The Beginning", "text": "The blade sits well in your hand...", "choices": [ { "label": "Stand your ground and fight.", "to": "passage_2", "requires": { "item": "shield" }, "grants": { "item": "captains_blade", "label": "Captain's Blade" } } ] } ```

Endings are nodes with `end: true` and an `endingType`. Items are stored in a central registry rather than inline on each node, so checking a player's inventory is an O(1) lookup rather than a scan across all passages.

The Player and the Grimoire both read from the same `story` object shape and are driven by the same `renderNode()` / `showEnding()` functions — the built-in tale and any tale written in the Grimoire are interchangeable at runtime.
