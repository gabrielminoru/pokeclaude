# Pokémon mod for Claude Code

A Pokémon party above your Claude Code prompt. Pick a starter, meet a wild Pokémon every hour, and level up your active Pokémon with Claude's tool calls. Pokémon evolve by level, stone or friendship.

## Install

At the prompt of a Claude Code terminal session, type:

```
/plugin install pokemon --marketplace gabrielminoru/pokeclaude
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session). It's active right away: Professor Oak appears above the prompt, so choose your starter.

## Development

To run it from a local copy instead:

1. Put this folder at `~/.claude/mods/pokemon`, so that `~/.claude/mods/pokemon/.claude-plugin/plugin.json` exists.
2. Open `~/.claude/settings.json` and add this line inside `"env"` (create the `"env": { }` block if it isn't there):
   ```json
   "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/pokemon"
   ```
   If you already have a `CLAUDE_CODE_PLUGIN_DIRS`, append `:~/.claude/mods/pokemon` to it instead.
3. Start a new Claude Code session (`claude`).

To try it once without touching settings, run `claude --plugin-dir ~/.claude/mods/pokemon` instead of step 2.

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
| `/pokemon hide` / `show` | Hide or show the display above the prompt |
| `/party` | Open the party pane with all six sprites; type it again (or press Close) to close it |
| `/pokedex` | Seen, caught, shinies |
| `/bag` / `/bag use <stone> <slot\|name>` | Evolution stones |

## How it plays

- **EXP:** every successful tool call Claude makes gives EXP to your active Pokémon. It gets excited (×1.5 EXP) with lots of activity and bored (×0.75) after 3 idle hours.
- **Wild encounters:** one per hour while you have a free slot (party max 6). Shinies are 1 in 256.
- **Stones:** an evolution stone can turn up every few hours.
- **No harm:** nothing can make your Pokémon faint.

Your party is saved per machine. Sprites are downloaded at runtime, and no Pokémon artwork ships in this folder (Pokémon © Nintendo / Game Freak).
