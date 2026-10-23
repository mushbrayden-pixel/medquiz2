MEDQUIZ PATCH — FIX PATHOLOGY SAQ MARKING

This patch keeps the existing Supabase database and saved attempts. It does not use AI.

FILES IN THIS PACKAGE
- index.html: updated MedQuiz page and clearer error handling.
- functions/pathology-mark.js: Cloudflare Pages Function that marks saved Pathology SAQ attempts using deterministic key-point matching.

IMPORTANT
The unreadable-response error usually means the browser received an HTML 404/error page instead of JSON from /pathology-mark. The function file must be deployed with the site at exactly: functions/pathology-mark.js

DEPLOY USING YOUR EXISTING GITHUB REPOSITORY
1. Unzip this package on your computer.
2. Open your existing GitHub repository named MedQuiz.
3. Replace the repository's existing index.html with this package's index.html.
4. Create a folder named functions in the repository root if it does not exist. Inside it, upload pathology-mark.js. The final path must be functions/pathology-mark.js. Do not upload it as a root-level file.
5. Commit the changes. Wait for Cloudflare Pages to finish deploying.
6. In Cloudflare Pages > your project > Settings > Variables and Secrets, confirm these are configured for the Production environment: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY. Do not put the secret key in index.html or share it in chat.
7. Test by opening https://hub25.pages.dev/pathology-mark in a browser. A message saying “Use POST for Pathology marking.” means the function route exists. A 404 means Cloudflare did not deploy the function folder.
8. Sign in to MedQuiz, open My recent attempts, open the previously saved Pathology attempt, and press “Retry marking”. Do not submit the quiz again.

IF YOU DEPLOY FROM A DIRECT-UPLOAD STATIC-ASSETS SCREEN
A static-only upload may not deploy Pages Functions. Use the existing GitHub-connected Pages project so Cloudflare builds the functions/ folder.

The function validates the signed-in user and only allows them to mark their own attempt, except for an admin. It updates the existing student_answers and attempts rows; it does not create a new attempt.
