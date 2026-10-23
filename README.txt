MedQuiz — Cloudflare Pages non-AI Pathology SAQ marking

This package is adapted for Cloudflare Pages. It includes:
- index.html — frontend configured to call /api/pathology-mark
- functions/api/pathology-mark.js — Cloudflare Pages Function for deterministic keyword/rubric marking

Deploy from the repository root so Cloudflare detects the functions/ directory. No build command is needed for this static HTML site.

Cloudflare Pages > Settings > Variables and Secrets (set for Production and Preview as appropriate):
- SUPABASE_URL = your Supabase project URL
- SUPABASE_PUBLISHABLE_KEY = the project's publishable/anon key (not secret)
- SUPABASE_SECRET_KEY = the Supabase secret/service-role key; store as a Secret only

Never put SUPABASE_SECRET_KEY in index.html or GitHub. The existing public key in index.html is public by design.

Important: keyword/rubric marking is approximate and may miss valid wording not covered by rubric keywords. Use explicit markingPoints with point, marks, and keywords for each SAQ. Have an administrator review borderline answers.

Before production use, test with a separate test attempt if possible. The function reads and updates the existing Supabase tables attempts, student_answers, quizzes, questions, and optionally user_roles. It assumes those table/column names match your database. Do not delete or recreate Supabase data.
