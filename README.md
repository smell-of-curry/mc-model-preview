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
| `mode` | Action mode: `render` (default) or `post` | No | `render` |
| `artifact-path` | Path to downloaded artifact directory (required for `post` mode) | No | - |

### Custom Resource Pack Path

If your resource pack is in a subdirectory:

```yaml
- name: Minecraft Model Preview
  uses: smell-of-curry/mc-model-preview@latest
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    resource-pack-path: './my-resource-pack'
```

### Fork PR Support

Pull requests from forks have limited permissions and cannot push images to branches or post comments directly. This action automatically detects fork PRs and uploads rendered images as workflow artifacts instead.

To enable full fork PR support with automatic comment posting, you need **two workflows**:

#### 1. Main Workflow (`.github/workflows/model-preview.yml`)

This workflow runs on pull requests and renders the models. For fork PRs, it saves images as an artifact.

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
          fetch-depth: 0

      - name: Minecraft Model Preview
        uses: smell-of-curry/mc-model-preview@latest
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

#### 2. Post Workflow (`.github/workflows/model-preview-post.yml`)

This workflow runs after the main workflow completes, downloads the artifact, and posts the comment with full permissions.

```yaml
name: Post Model Preview

on:
  workflow_run:
    workflows: ["Model Preview"]
    types: [completed]

permissions:
  contents: write
  pull-requests: write

jobs:
  post-comment:
    runs-on: ubuntu-latest
    if: >
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request'

    steps:
      - uses: actions/checkout@v4

      - name: Get PR number
        id: pr
        uses: actions/github-script@v7
        with:
          script: |
            const artifacts = await github.rest.actions.listWorkflowRunArtifacts({
              owner: context.repo.owner,
              repo: context.repo.repo,
              run_id: context.payload.workflow_run.id,
            });
            const artifact = artifacts.data.artifacts.find(a => a.name.startsWith('model-preview-pr-'));
            if (!artifact) {
              core.info('No model preview artifact found');
              return;
            }
            const prNumber = artifact.name.replace('model-preview-pr-', '');
            core.setOutput('number', prNumber);
            core.setOutput('artifact_name', artifact.name);

      - name: Download artifact
        if: steps.pr.outputs.number
        uses: actions/download-artifact@v4
        with:
          name: ${{ steps.pr.outputs.artifact_name }}
          path: artifact
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Post Model Preview Comment
        if: steps.pr.outputs.number
        uses: smell-of-curry/mc-model-preview@latest
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          mode: post
          artifact-path: artifact
```

> **Note:** For non-fork PRs, the main workflow handles everything automatically—no second workflow is needed. The post workflow only activates when an artifact is present (fork PRs).

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
