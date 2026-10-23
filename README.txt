MedQuiz non-AI SAQ marking update

Files included:
- index.html: updated MedQuiz page with rubric-based SAQ marking labels and admin editor support for markingPoints.
- netlify/functions/pathology-mark.js: secure Netlify function that marks submitted Pathology SAQs using keyword/rubric rules. No Gemini or other AI API is called.
- netlify.toml: Netlify publish and function directory configuration.

Required Netlify environment variables:
SUPABASE_URL
SUPABASE_SECRET_KEY
SUPABASE_PUBLISHABLE_KEY

GEMINI_API_KEY is no longer required by this function. Keep Supabase secret keys only in Netlify environment variables, never in index.html.

Recommended SAQ format uses markingPoints, each with point, marks, and keywords. Example:
[{"question":"Describe two events in acute inflammation.","marks":2,"markingPoints":[{"point":"Vasodilation","marks":1,"keywords":["vasodilation","dilation of arterioles"]},{"point":"Increased vascular permeability","marks":1,"keywords":["increased vascular permeability","vascular leakage"]}]}]

Important: keyword grading is deterministic, not human-level semantic marking. Include accepted synonyms in each criterion. Existing modelAnswer questions remain supported as a less precise fallback.
