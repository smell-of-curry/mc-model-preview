# Minecraft Model Preview

A GitHub Action that automatically generates visual previews of changed Minecraft Bedrock Edition models in pull requests.

## Features

- Detects new or modified entity models, textures, and animations in PRs
- Generates side-by-side "before" and "after" renders
- Supports shiny texture variants (for Pokemon-style resource packs)
- Posts comparison images directly as PR comments
- Falls back to job summary if PR comments aren't available

## Usage

Add this workflow to your repository at `.github/workflows/model-preview.yml`:

```yaml
name: Model Preview

on:
  pull_request:

permissions:
  contents: write
  pull-requests: write

jobs:
  model-preview:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Required for base branch comparison

      - name: Minecraft Model Preview
        uses: smell-of-curry/mc-model-preview@latest
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `github-token` | GitHub token for API access and PR comments | Yes | - |
| `resource-pack-path` | Path to the resource pack in your repository | No | `.` |

### Custom Resource Pack Path

If your resource pack is in a subdirectory:

```yaml
- name: Minecraft Model Preview
  uses: smell-of-curry/mc-model-preview@latest
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    resource-pack-path: './my-resource-pack'
```

## How It Works

1. **Scans Entity Files**: Parses all `entity/*.json` files to build a map of entity identifiers to their associated resources (models, textures, animations, materials)

2. **Detects Changes**: Compares the PR's changed files against the entity resource map to identify affected entities

3. **Generates Renders**: For each affected entity:
   - Creates a `.bbmodel` (BlockBench) representation
   - Renders the model using Three.js in a headless browser
   - Captures both "before" (base branch) and "after" (PR branch) states

4. **Posts Results**: Uploads rendered images and posts a comparison table to the PR

## Resource Pack Structure

The action expects a standard Minecraft Bedrock resource pack structure:

```
your-resource-pack/
├── entity/           # Entity definition files (.json)
├── models/           # Geometry files (.json)
│   └── entity/
├── textures/         # Texture files (.png, .tga)
│   └── entity/
├── animations/       # Animation files (.json)
└── materials/        # Material files (.material, .json)
```

## Example Output

When a PR modifies entity models or textures, the action posts a comment like:

| Entity | Before | After |
|--------|--------|-------|
| `minecraft:creeper` | ![before](image) | ![after](image) |
| `pokeb:pikachu` | _New model_ | ![after](image) |
| `pokeb:pikachu` (shiny) | _New model_ | ![after](image) |

## Requirements

- The workflow must have `contents: write` and `pull-requests: write` permissions
- Use `fetch-depth: 0` in checkout to enable base branch comparison
- Runs on `ubuntu-latest` (requires Chrome for headless rendering)

## Related Work

- [TheAfroOfDoom/omegaflowey-minecraft-remastered](https://github.com/TheAfroOfDoom/omegaflowey-minecraft-remastered/tree/main/.github/actions/setup-animated-java-exports) - Similar approach for Animated Java exports

## License

ISC
