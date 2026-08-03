# T2 H05 image derivative implementation report

## Baseline

- Repository: `ZimmonAI/z-s_app`
- Required ancestor: `1518e7adb38429a9dc931ed17730189621c4fd2c`
- Working branch: `agent/h05-image-derivatives`
- H04B external database proof: still pending

## Implemented scope

- Add-only migration `0011_z_s_image_derivatives` and guarded rollback.
- Immutable, client-scoped derivative jobs and verified output lineage.
- Lease, retry, maximum-attempt, and duplicate-output controls.
- Pure bounded PNG verification, decode, resize, and encode path.
- Existing provider reader/writer reuse with server-side credential references.
- Separate normal storage object/copy persistence for derivative outputs.
- Upload-completion enqueue and bounded immediate/periodic worker execution.
- Signed client-session status API and additive workspace status section.
- Unit, runtime, migration, and PostgreSQL integration proof files.
- Dedicated H05 CI workflow plus compatibility scope update for the existing 2B-07 workflow.

## Deliberate constraints

The processor accepts and emits PNG only. Other preset output formats fail with a safe not-ready code. This is an explicit implementation envelope, not silent format substitution.

No live provider, approval database, deployment, or shared-environment mutation was performed. The PR must remain draft while H04B is pending.
