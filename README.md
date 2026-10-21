# Lumawb installer builds

This repository contains public build instructions and published installers only. Lumawb application source remains in the private `VGabby/lumawb-inference` repository. It publishes no source archives or compiler logs.

## Release build

**Build release installers and signed updates** (`.github/workflows/release.yml`) runs manually on the standard `windows-2022` and `macos-14` (Apple Silicon) GitHub-hosted runners. Standard runners for public repositories do not charge runner minutes. No larger runner, paid signing service, or paid hosting is configured. [GitHub billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

Before a build, the publisher adds a temporary **read-only deploy key** to the private source repository and stores its private half as the `windows-release` environment's `LUMAWB_SOURCE_DEPLOY_KEY` secret. Never commit or print the key. Remove the deploy key and secret after both jobs have checked out the source. The environment is restricted to the `main` branch; allow only trusted maintainers to edit or dispatch this workflow, because anyone who can change a secret-using workflow can potentially expose its secrets.

Run the workflow with the exact reviewed 40-character source commit from `release/lumawb-desktop`. The checkout uses the temporary SSH key, verifies that the branch HEAD is the supplied commit, and does not persist credentials. Each job builds the installer. Tests (core tests, Python reference parity, offline HTTP integration and the Windows GPU diagnostic) are opt-in with the `run_tests` input; the publisher runs them locally before each release commit.

Swatinem/rust-cache caches compiled third-party Rust dependencies and the Cargo registry per platform, keyed by `Cargo.lock`. Lumawb's own crate is not cached. After the first run, builds reuse the cache. Caches stay within GitHub's free 10 GB per-repository limit and expire after 7 days unused. This repository has no pull-request workflows, so forks cannot run a workflow that reads the cache without maintainer approval.

## Update signing

The same environment holds `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, the Tauri updater (minisign) key. `scripts/build-release.mjs` removes both from its environment at start and passes them only to the installer build command, so dependency installs and tests never see them. Each job produces:

| Platform | Installer | Signed update file |
| --- | --- | --- |
| Windows x64 | `Lumawb-Desktop-win32-x64-setup.exe` | the same installer plus `.sig` |
| Apple Silicon | `Lumawb-Desktop-darwin-arm64.app.zip` | `Lumawb-Desktop-darwin-arm64.app.tar.gz` plus `.sig` |

The matching public key is built into the app, which refuses any update whose signature does not verify. The publisher keeps an offline backup of the private key; if it is lost, installed apps cannot accept future updates.

## Publishing a release

1. Download both artifacts (they expire after one day).
2. Write the release notes and run `node scripts/make-latest.mjs --version X.Y.Z --notes notes.md --dir <artifacts> --out latest.json`.
3. Create release `vX.Y.Z` as a normal release (not a prerelease) with both installers, the `.app.tar.gz`, both `.sig` files, `latest.json` and a combined `SHA256SUMS.txt`.

Apps read `releases/latest/download/latest.json`, so the newest normal release must always contain `latest.json`, and every release needs a higher version.

## Testing an update on Windows

**Test Windows in-app update** (`.github/workflows/update-test-windows.yml`) needs no secrets. It installs an older release from its public installer, runs `Lumawb Desktop.exe --install-update` (the same steps as the in-app **Update** button), and passes only if the installed version becomes the expected one and the app restarts.

## Logs and diagnostics

Build commands write raw output only to temporary runner files, which are deleted. Public logs show phase names and success/failure summaries. When a build fails, the artifact instead contains only `build-diagnostics.enc.json`: the captured logs, compressed and encrypted with a random AES-256-GCM key, which is itself encrypted with RSA-OAEP (SHA-256) to `diagnostics-public.pem`. The matching private key exists only on the publisher's machine.

The Windows installer is unsigned and can show SmartScreen warnings. Mac apps use ad hoc signing without notarization. This repository does not buy certificates or change billing settings.
