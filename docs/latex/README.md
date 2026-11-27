# SPIR documentation set

LaTeX sources for the SPIR project documentation. Every document is separate, numbered and has its own
document-control page (revision history, approvals, related documents). Change a document in the same
pull request as the code it describes.

| No. | Document | Folder | Main readers |
|---|---|---|---|
| SPIR-EXS-001 | Executive Summary | `01-executive-summary/` | Managers, stakeholders |
| SPIR-SRS-001 | Software Requirements Specification | `02-srs/` | Everyone |
| SPIR-SDD-001 | Software Design Description (architecture, UML, data, API, security) | `03-design/` | Vendor, developers |
| SPIR-RTM-001 | Requirements Traceability Matrix (spec v1.1, 127 requirements) | `04-traceability/` | Vendor, reviewers |
| SPIR-REL-001 | Release Notes and Revision History | `05-release-notes/` | Everyone |
| SPIR-SCP-001 | Scope, Limitations, Risks and Roadmap | `06-scope-roadmap-risks/` | Managers, vendor |
| SPIR-TST-001 | Test Plan and Report | `07-test-report/` | Vendor, quality |
| SPIR-UG-001 | User Guide (supplier portal, company portal, phone scanning) | `08-user-guide/` | Suppliers, receiving team |
| SPIR-OPS-001 | Deployment and Operations Guide | `09-deployment-operations/` | Developers, IT |

## Building

GitHub builds every PDF on each change under `docs/latex/` (workflow **Documentation**, `.github/workflows/docs.yml`):
open the run and download the `spir-documentation` artifact.

Locally (TeX Live 2023 or later with `latexmk`):

```bash
cd docs/latex
make          # all PDFs into docs/latex/build/
make srs      # one document: exs srs sdd rtm rel scp tst ug ops
make clean
```

## How it is organised

| Path | What |
|---|---|
| `shared/project.tex` | Release number, date, author, repository. **Update on every release**; all documents use it. |
| `shared/spirdoc.sty` | Shared layout: cover, document control, headers, colours, tables, callouts, TikZ diagram styles. |
| `shared/glossary.tex`, `shared/related.tex` | Glossary and the list of documents. |
| `shared/rtmcount.tex` | Counts the traceability CSV so every document reports the same numbers. |
| `diagrams/*.tex` | UML and workflow diagrams in TikZ (context, deployment, components, use cases, domain model, sequences, state machines, workflows, timeline). Include with `\Diagram{name}{caption}`. |
| `04-traceability/rtm.csv` | One line per spec requirement: `id\|area\|priority\|requirement\|status\|evidence`. Status: I implemented, P partial, D deferred, V deviation, N not started, O to define. |
| `08-user-guide/img/` | Screenshots (fictional demo data only). |

## Conventions

* Document version (in each `\SetDoc`) changes when the document changes; the software release comes from `project.tex`.
* Add a row to the document's `\Revisions{...}` for every issued change.
* The repository is public: fictional data only in text and screenshots.
