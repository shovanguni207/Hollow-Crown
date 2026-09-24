/* =========================================================
   THE HOLLOW CROWN — a small branching-story engine
   with a Grimoire: a manager for many saved tales, each
   editable passage-by-passage and playtestable in place.

   STORY SHAPE: { items: {id: {label, description}},
   quests: {id: {title, description, objectives}}, nodes: {id: node} }
   Item definitions live once in `items`; choices only ever
   reference an item by id in `requires`/`grants`. This keeps a
   single source of truth for an item's display name no matter
   how many different choices grant or require it.
   ========================================================= */

// ---- Built-in story ---------------------------------------------
const DEFAULT_STORY = {
  items: {
    key: { label: "Iron Key", description: "Still warm. It hums faintly, as though it remembers a lock." },
    blade: { label: "Captain's Blade", description: "Notched but honest — a soldier's blade, not a looter's." }
  },
  quests: {},
  nodes: {
    start: {
      chapter: "I — The Gatehouse",
      text: "The undercroft gate hangs open, its iron teeth rusted mid-bite. Torchlight gutters somewhere below. You could take the wide stair, still warm with the footprints of looters who went before you or the narrow servant's passage, choked with cobwebs and colder air.",
      choices: [
        { label: "Take the wide stair, and whatever waits at its end.", to: "wideStair" },
        { label: "Slip into the servant's passage instead.", to: "narrowPath" }
      ]
    },
    wideStair: {
      chapter: "II — The Wide Stair",
      text: "The steps open into a hall stripped bare, except for a single iron key, still warm, resting on the dead king's overturned throne. Beside it, a captain's blade lies half-buried in ash, its edge notched but honest.",
      choices: [
        { label: "Take the key.", to: "haveKey", grants: { item: "key" } },
        { label: "Take the blade.", to: "haveBlade", grants: { item: "blade" } },
        { label: "Take neither, and go deeper empty-handed.", to: "deeper" }
      ]
    },
    narrowPath: {
      chapter: "II — The Servant's Passage",
      text: "The passage is tight and dark, but it leads you unseen past a sleeping thing that stirs in the wide hall above. You emerge into the lower vault a full turn ahead of any rival looter, though you carry nothing but your own two hands.",
      choices: [
        { label: "Press on into the vault.", to: "deeper" }
      ]
    },
    haveKey: {
      chapter: "III — Descending",
      text: "The key hums faintly against your palm as you descend, as though it remembers a lock it hasn't seen in a hundred years. At the bottom of the stair, the vault door is sealed — but keyholed.",
      choices: [
        { label: "Fit the key to the lock.", to: "goodEnding" },
        { label: "Search for another way in instead.", to: "deeper" }
      ]
    },
    haveBlade: {
      chapter: "III — Descending",
      text: "The blade sits well in your hand, and it's good that it does because something in the dark below is already moving toward the sound of your footsteps.",
      choices: [
        { label: "Stand your ground and fight.", to: "fightEnding" },
        { label: "Run for the vault door.", to: "deeper" }
      ]
    },
    deeper: {
      chapter: "III — The Vault Door",
      text: "You reach the vault door itself: black iron, unmarked, sealed with no visible lock. Whatever opens it, it isn't strength alone.",
      choices: [
        { label: "Use the iron key.", to: "goodEnding", requires: { item: "key" } },
        { label: "Force it with the blade.", to: "fightEnding", requires: { item: "blade" } },
        { label: "Press your palm flat against the cold iron and wait.", to: "waitEnding" }
      ]
    },
    goodEnding: {
      end: true,
      endingType: "The Crown Restored",
      text: "The key turns as if the lock had been waiting a hundred years for exactly this hand. Inside, the crown sits untouched on a cushion of rotted velvet, and beneath it, a note in a script older than the kingdom itself, addressed, somehow, to you."
    },
    fightEnding: {
      end: true,
      endingType: "The Long Way Down",
      text: "The blade earns its keep. What you find past the door isn't a crown, it's a way further down, into passages no looter's map has ever charted. You leave the undercroft with empty hands and a map no one else has."
    },
    waitEnding: {
      end: true,
      endingType: "What the Iron Remembers",
      text: "The door does not open for strength, or for keys. It opens because you asked it nothing and took nothing and the vault, for the first time in a century, decides to simply let someone leave with what they came for: the truth of what happened here."
    }
  }
};