# MaugoodAI — Release notes

Every release gets one file in this folder, named after its tag
(`vX.Y.Z.md`), and one row in the table below — newest first.

**Adding a release:** copy the latest note as a template, fill it in from
`git log <previous-tag>..<new-tag>`, add the row here, and commit both with
the version bump before (or together with) pushing the tag.

| Version | Date | Branch | Commit | Notes |
|---|---|---|---|---|
| **v1.1.26** | 12 Oct 2026 | new-feature | `b03dfe0` | [Attendance devices, Template 1 PDF reports, full UI/UX redesign](v1.1.26.md) |
| v1.1.25 | 13 Jul 2026 | release-omran | `1468ed9` | AD Users (Microsoft Entra sync + role management) — notes not recorded |
| v1.1.24 | 23 Jun 2026 | release-omran | `083f98c` | notes not recorded |
| v1.1.23 | 17 Jun 2026 | release-omran | `d6d85ac` | notes not recorded |
| v1.1.22 | 15 Jun 2026 | release-omran | `5362c14` | notes not recorded |
| v1.1.21 | 13 Jun 2026 | release-omran | `6699cb6` | notes not recorded |
| v1.1.20 | 11 Jun 2026 | release-omran | `fc428a0` | notes not recorded |
| v1.1.19 | 10 Jun 2026 | release-omran | `903692c` | notes not recorded |
| v1.1.18 | 10 Jun 2026 | release-omran | `7735f84` | notes not recorded |
| v1.1.17 | 02 Jun 2026 | release/staging-testing | `156cbe1` | notes not recorded |
| v1.1.16 | 30 May 2026 | release/staging-testing | `b51ba3b` | notes not recorded |
| v1.1.5 – v1.1.14 | 02–03 May 2026 | main | — | see `release-history/` build records |

Releases before v1.1.26 have build records only (`release-history/vX.Y.Z.json`:
commit, branch, build time). Their change lists can be reconstructed with
`git log` between the commits above if they are ever needed.
