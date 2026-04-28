# Changesets

This monorepo uses [changesets](https://github.com/changesets/changesets) for independent versioning of each package.

## Recording a change

When you make a change that should ship in a release, run:

```bash
npx changeset
```

You'll be asked which package(s) the change affects and what level (`patch` / `minor` / `major`), then prompted for a short summary. The result is a Markdown file committed to this directory, which gets consumed by `changeset version` later.

## Releasing

When you're ready to cut releases:

```bash
npx changeset version          # apply pending changesets: bumps versions, regenerates per-package CHANGELOG.md, removes consumed changeset files
git commit -am "chore: version packages"
git push
git tag <pkg>-v<semver>        # e.g. evm-v1.0.0
git push --tags
```

The tag triggers the matching `publish:<pkg>` CI job which runs `npm publish` for that package only.
