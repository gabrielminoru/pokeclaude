# Pokémon mod for Claude Code

A Pokémon party above your Claude Code prompt. Pick a starter, meet a wild Pokémon every hour, and level up your active Pokémon with Claude's tool calls. Pokémon evolve by level, stone or friendship.

![Your active Pokémon above the prompt](screenshots/band.png)

![The /party pane with all six sprites](screenshots/party.png)

## Install

At the prompt of a Claude Code terminal session, type:

```
/plugin install pokemon --marketplace gabrielminoru/pokeclaude
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). It's active right away: Professor Oak appears above the prompt, so choose your starter.

## Update

If you installed the plugin from the marketplace, update it from a Claude Code session:

```
/plugin marketplace update pokeclaude
/plugin update pokemon
```

Then restart Claude Code to apply the new version. `/plugin update pokemon` on its own is usually enough; refreshing the marketplace first makes sure the latest catalog is visible.

Your party, Pokédex, bag and pending choices are kept. The Boxes start empty; the new generation view reads the Pokédex you already have.

If you run from a local clone instead, update the clone and restart the session if the new code is not picked up:

```
cd ~/pokeclaude
git pull --ff-only
```

## Development

To run it from a local copy instead:

1. Clone this repository: `git clone https://github.com/gabrielminoru/pokeclaude.git ~/pokeclaude`
2. Open `~/.claude/settings.json` and add this line inside `"env"` (create the `"env": { }` block if it isn't there):
   ```json
   "CLAUDE_CODE_PLUGIN_DIRS": "~/pokeclaude"
   ```
   If you already have a `CLAUDE_CODE_PLUGIN_DIRS`, append `:~/pokeclaude` to it instead.
3. Start a new Claude Code session (`claude`). Edits to the folder reload while it runs.

To try it once without touching settings, run `claude --plugin-dir ~/pokeclaude` instead of step 2.

## Requirements

- **Sprites** show as images in **Ghostty** or **kitty**. Other terminals, tmux and the desktop app show a `[Charmander]` text badge instead.
- **`curl`**, plus network access to `pokeapi.co` and `raw.githubusercontent.com`. Sprites and data download on first use and are cached in `~/.claude/plugins/data/pokemon/`.

## Commands

| Command | What it does |
|---|---|
| `/pokemon` | Active Pokémon's stats, your party, and all subcommands |
| `/pokemon keep [nickname]` / `letgo` | Answer a wild encounter |
| `/pokemon stop` / `evolve <species>` | Stop an evolution, or pick a branch |
| `/pokemon switch \| release \| nick <slot\|name>` | Manage your party (slots 1–6) |
| `/pokemon store \| take <slot\|name>` | Put a Lv. 100 Pokémon into the Boxes, or take one back |
| `/pokemon swap <party slot> <box slot>` | Trade a Lv. 100 party member for a boxed one |
| `/pokemon gen <1–9\|all>` / `region <name>` | Which generation the wild encounters come from |
| `/pokemon stage <base\|all>` | Which stage of the evolution chain the wild encounters come from |
| `/pokemon levelcap <party\|off\|n>` | How strong a wild encounter may be |
| `/pokemon hide` / `show` | Hide or show the display above the prompt |
| `/party` | Open the party pane with all six sprites; type it again (or press Close) to close it |
| `/boxes` | Open the Boxes pane; type it again (or press Close) to close it |
| `/pokedex` | Open the generation Pokédex; `gen <1–9>` picks a generation |
| `/pokedex seen` / `caught` / `<number>` | The species you have seen or caught, and one of them by number |
| `/bag` / `/bag use <stone> <slot\|name>` | Evolution stones |

## How it plays

- **EXP:** every successful tool call Claude makes gives EXP to your active Pokémon. It gets excited (×1.5 EXP) with lots of activity and bored (×0.75) after 3 idle hours.
- **Wild encounters:** one per hour while you have a free slot (party max 6). Shinies are 1 in 256.
- **Stones:** an evolution stone can turn up every few hours.
- **No harm:** nothing can make your Pokémon faint.

Your party is saved per machine.

## Boxes

A Pokémon that reaches **Lv. 100** can retire to the Boxes and come back later. `/pokemon store <slot|name>` deposits it, `/pokemon take <slot|name>` brings it back, and `/boxes` opens the storage pane with 30 per page. `/pokemon swap <party slot> <box slot>` trades a Lv. 100 party member for a boxed one.

Lower levels are refused, and the last Pokémon in your party can never be stored. With a full party, taking a boxed Pokémon needs a free slot: store a Lv. 100 member or release one first.

## Generations

Wild encounters come from **Kanto (Generation I)** by default — the 151 species of the first games. `/pokemon gen` shows the one in play, `/pokemon gen 3` or `/pokemon region hoenn` switches to another, and `/pokemon gen all` brings every species back.

The Pokédex counts against the generation in play, so it can actually be finished: `Seen 12/151 · Caught 4/151` in Kanto, out of the 1025 species of the whole dex. The pane lets you browse any generation; only the `gen` command changes which generation wild encounters come from.

## Stages

Wild encounters come from **base forms** by default: a Charmander, never a Charizard. `/pokemon stage` shows the one in play, and `/pokemon stage all` brings every stage of the chain back.

Your own Pokémon still evolves the usual way, so the forms you reach fill the Pokédex like any other species.

## Level caps

A wild encounter never goes past the level of your best Pokémon: a party at level 5 meets a level 5 Pokémon, not a Dusclops at level 40.

A species that is too strong for the party does not come at all — a form only reached at level 36 waits for a party that is close to it.

`/pokemon levelcap` shows the ceiling in play, `/pokemon levelcap 25` sets a fixed one, and `/pokemon levelcap off` lifts it.

## The Pokédex

`/pokedex` opens the Pokédex pane. It is split by generation: pick **I–IX** at the top, 30 Pokémon per page, and press **View** for a registered species. `/pokedex gen 3` opens it on Hoenn without changing the generation wild encounters come from.

A species you have not met is a dark silhouette with `???` and no details. A species you have seen shows its name and sprite with `○ seen`, and a caught species shows `● caught` with its full card: types, ability, base stats and evolution line.

Any species obtained by evolution is registered as caught. Charmander → Charmeleon → Charizard fills all three entries, even without catching the later forms in the wild.

`/pokedex seen` and `/pokedex caught` still list the species as text, in Pokédex order, and `/pokedex <number>` asks about one of them:

```
$ /pokedex caught
Caught (4): Charmander, Gengar, Eevee, Dragonite

$ /pokedex 25
#025 Pikachu — seen
```

## The card

Each Pokémon carries its own numbers, read from PokeAPI: its type, its base stats and its ability. The party pane shows them on a card of its own, one per Pokémon, and `/pokemon` prints the active one's in full.

## Legal

This is an unofficial fan project, not affiliated with or endorsed by Nintendo, Game Freak, The Pokémon Company, or Anthropic. Pokémon and Pokémon character names are trademarks of Nintendo, Game Freak and The Pokémon Company.

The code ships no Pokémon artwork: sprites are downloaded at runtime from [PokeAPI](https://pokeapi.co/). The screenshots above show Pokémon sprites © Nintendo / Game Freak.

The code is released under the [MIT License](LICENSE). The license covers the code only, not Pokémon names, data or artwork.
