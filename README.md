# Lumawb installer builds

This repository contains public build instructions only. Lumawb application source remains in the private `VGabby/lumawb-inference` repository. It publishes no source archives or compiler logs.

## Windows build

The workflow runs manually on the standard `windows-2022` GitHub-hosted runner. Standard runners for public repositories do not charge runner minutes. No larger runner, paid signing service, or paid hosting is configured. [GitHub billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

Before a build, the publisher adds a temporary **read-only deploy key** to the private source repository and stores its private half as the `windows-release` environment's `LUMAWB_SOURCE_DEPLOY_KEY` secret. Never commit or print the key. Remove the deploy key and secret after the build. Restrict the environment to the `main` branch, protect that branch, and allow only trusted maintainers to edit or dispatch this workflow; anyone who can change a secret-using workflow can potentially expose that secret.

Run **Build Windows installer** with the exact reviewed 40-character source commit from `release/lumawb-desktop`. The checkout uses the temporary SSH key, fetches the current release branch, verifies that its HEAD is the supplied commit, and does not persist credentials. The job runs model/reference parity, offline HTTP integration, and builds an unsigned NSIS installer with its required native runtime.

Build commands write raw output only to temporary runner files, which are deleted. Public logs show phase names and success/failure summaries. Only validated `.exe` installers and `SHA256SUMS.txt` are copied to the uploaded artifact. Artifacts expire after one day; download them promptly. There are no push or pull-request triggers and no automatic release publication.

The unsigned installer can show SmartScreen warnings. A Microsoft Store MSIX submission is a separate route requiring publisher enrollment and certification. This workflow does not buy a certificate, submit to the Store, install an application on a user's computer, or change billing settings.
