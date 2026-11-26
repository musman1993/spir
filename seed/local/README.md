# Private samples (not committed)

Everything in this folder except this README is ignored by git, because real labels contain real
purchase orders, part numbers and supplier names, and the repository is public.

* `*.csv` here are loaded **after** `seed/spir_seed.csv` by `npm run db:seed`, `npm run db:reset`
  and `npm run dev:memory`. Use the same columns as the main CSV.
* Keep real label photos here too (e.g. `seed/local/photos/`) to test the label check.
