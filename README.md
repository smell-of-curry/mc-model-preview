# Mc Model Preview

A github action that provides a preview of changed minecraft models in a pull request.

[NOTICE] Currently only supports Minecraft Bedrock Edition Resource Pack Repositories.

## How it works

Install the action on your repo and configure it to the path of your resource pack, default `/`.

When someone opens up a pull request, the action will run and check if the user created a new model or modified an existing one.

It works by first scanning all linked paths in `entity/` to make a map of entity typeId's to the files they use (models, textures, animations, materials, etc.) Then if the pull request contains a change to a entity's files. 

The action will then generate a headless version of BlockBench, load up the entities textures, animations, and materials, and then generate a png (gif if animations) of the entity.

Then with those image/animation diffs, it will generate a comment on the pull request with a side by side comparison of the changed entities.

Allowing anyone reviewing the pull request to see the changes in a more visual way.

## Related Work:

- https://github.com/TheAfroOfDoom/omegaflowey-minecraft-remastered/tree/main/.github/actions/setup-animated-java-exports

## Future Features

- [ ] Generate a `.bbmodel` file for the entity with the changes to be quick downloaded and opened in BlockBench.

