# Releasing

A tag publishes a release. `.github/workflows/release.yml` checks that the tag names the packages' version, runs
the type check and the tests, builds, and packs each of the ten `@fadenstack` packages once. It then makes a GitHub
release for the tag with those files, and core's shared release workflow adds an SBOM per package (CycloneDX, BSI
TR-03183-2), the OSV scan with OpenVEX and CSAF, the OpenSSF Scorecard, keyless cosign signatures and GitHub's
attestations to it. Only then does it publish the same files to npm with trusted publishing: no npm token is stored
anywhere. A high-severity finding without a statement in `.vex/openvex.json` stops the release before anything is
published.

Started by hand (**Run workflow**), the workflow is a dry run: the build and the supply chain's SBOMs, scan and
Scorecard, shown in the run's summary; nothing is signed, uploaded or published.

1. Set the version in all ten packages and in `SDK_VERSION`, then update the lock file:

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
published by hand. A package added later (as `ui-web` and `ui-vue` were after 0.2.0-rc.1, and `mcp` and `skills`
before 0.3.0-rc.3) needs these steps for itself before its first tagged release. Publish it alone, from the file
`npm pack -w packages/<name>` makes at the commit you will tag (`npm publish <file>.tgz --access public`, with
`--tag next` for an rc version): the workflow then finds that version on npm, fetches the same file for its SBOM and
publishes the other packages.

1. Your npm account has two-factor authentication and may publish in the `fadenstack` organisation.
2. Build and publish the packages from a clean checkout of the tag:

    ```bash
    npm ci
    node scripts/version.mjs --check 0.2.0
    npm run typecheck && npm test && npm run build
    npm publish --workspaces --access public          # add --tag next for an rc version
    ```

3. Trust this workflow for each package, with npm 11.15 or later:

    ```bash
    for p in client agents ui ui-web ui-react ui-vue testing provenance skills mcp; do
      npx npm@11 trust github "@fadenstack/$p" --file release.yml \
        --repo fadenstack/fadenstack-sdk-typescript --env npm --allow-publish
    done
    ```

    (Or on npmjs.com: each package's **Settings**, **Trusted publisher**.)
4. On npmjs.com, set each package's **Publishing access** to **Require two-factor authentication and disallow
   tokens**.
5. In this repository's **Settings**, **Environments**, create `npm` and allow only tags `v*` to deploy to it.
