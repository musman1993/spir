# Build the SPIR documentation set.
#   make          build every document into build/
#   make srs      build one document (exs srs sdd rtm rel scp tst ug ops)
#   make clean    remove build products
LATEXMK ?= latexmk -pdf -interaction=nonstopmode -halt-on-error -file-line-error

DOCS := \
  01-executive-summary/SPIR-EXS-001-executive-summary \
  02-srs/SPIR-SRS-001-software-requirements \
  03-design/SPIR-SDD-001-software-design \
  04-traceability/SPIR-RTM-001-traceability-matrix \
  05-release-notes/SPIR-REL-001-release-notes \
  06-scope-roadmap-risks/SPIR-SCP-001-scope-roadmap-risks \
  07-test-report/SPIR-TST-001-test-plan-report \
  08-user-guide/SPIR-UG-001-user-guide \
  09-deployment-operations/SPIR-OPS-001-deployment-operations

.PHONY: all clean exs srs sdd rtm rel scp tst ug ops
all: $(addsuffix .pdf,$(DOCS))
	@mkdir -p build
	@for d in $(DOCS); do cp $$d.pdf build/; done
	@echo "PDFs are in docs/latex/build/"

%.pdf: %.tex $(wildcard shared/*) $(wildcard diagrams/*.tex) 04-traceability/rtm.csv
	cd $(dir $<) && $(LATEXMK) $(notdir $<)

exs: 01-executive-summary/SPIR-EXS-001-executive-summary.pdf
srs: 02-srs/SPIR-SRS-001-software-requirements.pdf
sdd: 03-design/SPIR-SDD-001-software-design.pdf
rtm: 04-traceability/SPIR-RTM-001-traceability-matrix.pdf
rel: 05-release-notes/SPIR-REL-001-release-notes.pdf
scp: 06-scope-roadmap-risks/SPIR-SCP-001-scope-roadmap-risks.pdf
tst: 07-test-report/SPIR-TST-001-test-plan-report.pdf
ug:  08-user-guide/SPIR-UG-001-user-guide.pdf
ops: 09-deployment-operations/SPIR-OPS-001-deployment-operations.pdf

clean:
	@for d in $(DOCS); do (cd $$(dirname $$d) && latexmk -C $$(basename $$d).tex >/dev/null 2>&1 || true); done
	rm -rf build
