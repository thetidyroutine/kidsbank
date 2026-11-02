# KidsBank

A small family pocket-money app. Static site on GitHub Pages (`docs/`), Postgres and login on Supabase.

- `docs/` - the website, plain HTML, CSS and JavaScript with no build step.
- `sql/001_schema.sql` - tables, row level security and the weekly allowance job.
- `tools/` - local test server with a fake Supabase client: `python tools/devserver.py`, then open `http://localhost:8766/?as=mia`.

The publishable key in `docs/config.js` is meant for browsers. All access rules are enforced by row level security in the database. No personal data belongs in this repository.
