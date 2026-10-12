# Releasing

A tag publishes a release. `.github/workflows/release.yml` checks that the tag names the packages' version, runs
the type check and the tests, builds, and publishes the five `@fadenstack` packages to npm with trusted
publishing: no npm token is stored anywhere.

1. Set the version in all five packages and in `SDK_VERSION`, then update the lock file:

    ```bash
    node scripts/version.mjs 0.2.0
    npm install
    ```

2. Commit, then tag and push:

    ```bash
    git tag v0.2.0
    git push origin main v0.2.0
    ```

3. Watch the **Release** workflow. A version with a suffix (`v0.2.0-rc.1`) is published under the dist-tag
   `next`, so `npm install` keeps getting the latest release.

A version can never be published twice, not even after it is removed. Rehearse with an rc version. If the
workflow stops half-way, run it again: it skips the packages that are on npm already.

## Before the first release (once)

npm lets a package trust a workflow only after the package exists, so the first version of each package is
published by hand.

1. Your npm account has two-factor authentication and may publish in the `fadenstack` organisation.
2. Build and publish the five packages from a clean checkout of the tag:

    ```bash
    npm ci
    node scripts/version.mjs --check 0.1.0
    npm run typecheck && npm test && npm run build
    npm publish --workspaces --access public          # add --tag next for an rc version
    ```

3. Trust this workflow for each package, with npm 11.15 or later:

    ```bash
    for p in client agents ui ui-react testing; do
      npx npm@11 trust github "@fadenstack/$p" --file release.yml \
        --repo fadenstack/fadenstack-sdk-typescript --env npm --allow-publish
    done
    ```

    (Or on npmjs.com: each package's **Settings**, **Trusted publisher**.)
4. On npmjs.com, set each package's **Publishing access** to **Require two-factor authentication and disallow
   tokens**.
5. In this repository's **Settings**, **Environments**, create `npm` and allow only tags `v*` to deploy to it.
