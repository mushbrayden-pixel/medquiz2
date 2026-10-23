'use strict';

// Cloudflare Pages Function: AI-assisted Pathology SAQ marking.
// Required Cloudflare secrets/variables:
// SUPABASE_URL
// SUPABASE_SECRET_KEY
// SUPABASE_PUBLISHABLE_KEY
// OPENAI_API_KEY
//
// Optional:
// OPENAI_MARKING_MODEL (defaults to gpt-4.1-mini)

function makeCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const requestOrigin = new URL(request.url).origin;

  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };

  if (origin && origin === requestOrigin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function reply(status, data, headers) {
  return new Response(
    data === null ? null : JSON.stringify(data),
    { status, headers }
  );
}

async function supabaseRequest(env, path, options = {}) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY;

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error('Supabase server configuration is missing.');
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    }
  );

  const raw = await response.text();

  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    console.error(
      'Supabase request failed:',
      response.status,
      typeof data === 'string' ? data : JSON.stringify(data)
    );

    const detail =
      typeof data === 'string'
        ? data
        : (data?.message || data?.hint || 'Database request failed.');

    throw new Error(
      `Database request failed (${response.status}): ${detail}`
    );
  }

  return data;
}

async function markAnswerAI(
  answer,
  maxMarks,
  questionText,
  scheme,
  correctAnswer,
  explanation,
  env
) {
  const studentText = String(answer || '').trim();
  const maximum = Math.max(0, Number(maxMarks) || 0);

  if (!studentText) {
    return {
      awarded: 0,
      maximum,
      feedback:
        'No answer was entered. Review the question and model answer, then try to include the important required concepts.',
      criteria: []
    };
  }

  if (!env.OPENAI_API_KEY) {
    throw new Error(
      'AI marking is not configured. Add OPENAI_API_KEY in Cloudflare Pages > Settings > Variables and Secrets.'
    );
  }

  const rubricText = String(scheme || '').trim();
  const referenceText = String(correctAnswer || '').trim();
  const explanationText = String(explanation || '').trim();

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      awarded: {
        type: 'number'
      },
      feedback: {
        type: 'string'
      },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            criterion: {
              type: 'string'
            },
            status: {
              type: 'string',
              enum: [
                'correct',
                'partially correct',
                'missing',
                'incorrect'
              ]
            },
            marks_awarded: {
              type: 'number'
            },
            marks_available: {
              type: 'number'
            },
            explanation: {
              type: 'string'
            }
          },
          required: [
            'criterion',
            'status',
            'marks_awarded',
            'marks_available',
            'explanation'
          ]
        }
      }
    },
    required: [
      'awarded',
      'feedback',
      'criteria'
    ]
  };

  const instructions = `
You are an experienced, fair medical-school Pathology examiner.

Your task is to mark a student's short-answer question using the
actual question, its maximum marks, and the supplied marking guide
or model answer.

CORE MARKING PRINCIPLES

1. MARK MEANING, NOT WORDING.
Award credit when the student correctly explains a medical concept,
even if their wording differs from the model answer.

Accept medically valid synonyms, standard abbreviations,
equivalent terminology, and valid alternative explanations.

Do not require students to reproduce the model answer word for word.

2. AWARD FAIR PARTIAL CREDIT.
If a student demonstrates part of a concept correctly but omits
an important detail, award credit for the part demonstrated.

Do not automatically give zero for an answer that is incomplete
but contains correct medical knowledge.

Award full marks for a criterion only when the required concept
is adequately explained according to the question and marking guide.

3. RECOGNISE DISTINCT KEY POINTS.
Identify the important assessable points required by the question.

Break the total into clear, independent criteria. Allocate marks
in proportion to the importance and complexity of each criterion.

If the supplied rubric gives explicit marks for its criteria,
respect those marks as far as possible.

If no detailed rubric is supplied, construct a reasonable marking
scheme from the question and model answer.

Do not invent unnecessary requirements or penalise students for
omitting details that the question did not reasonably require.

4. AVOID UNFAIR DEDUCTIONS.
Do not penalise different wording when the medical meaning is correct.

Do not deduct marks twice for the same omission.

Do not award the same credit repeatedly for repeating one idea.

Do not treat an omitted optional example as a major error.

Do not assume a statement is wrong simply because it is absent
from the model answer. Evaluate whether it is medically valid
and relevant to the question.

If the student gives contradictory statements, assess the
contradiction fairly and explain its effect on the relevant criterion.

5. IDENTIFY FOUR TYPES OF PERFORMANCE.

Use "correct" when the criterion is adequately met.

Use "partially correct" when the student demonstrates some,
but not all, of the required knowledge.

Use "missing" when the criterion is not addressed.

Use "incorrect" when the student gives a materially incorrect
or misleading explanation instead of the required knowledge.

6. PROVIDE USEFUL FEEDBACK.
For every criterion, state:
- The key point being assessed.
- The marks awarded and marks available.
- Whether the point is correct, partially correct, missing,
  or incorrect.
- A brief explanation of why the marks were awarded.

In the overall feedback, identify the student's strengths,
the most important omissions or errors, and how to improve.

Be specific. Avoid vague comments such as "study more."

7. MEDICAL ACCURACY.
Use established medical knowledge to judge the student's answer.
For Pathology questions, consider the relevant disease mechanisms,
morphology, clinical features, complications, and prevention
where the question asks for them.

Accept equivalent valid medical explanations.

Do not award marks for medically false statements, irrelevant
material, or unsupported claims presented as established fact.

If a statement is ambiguous, interpret it reasonably in context
rather than assuming the worst.

8. MARK LIMITS AND CONSISTENCY.
All marks must be non-negative.

Marks awarded for a criterion cannot exceed marks available.

The total awarded must never exceed the question maximum.

The sum of marks awarded across all criteria must equal the
overall awarded score.

The sum of marks available across criteria must equal the
question maximum.

Use sensible partial marks where appropriate. Avoid false precision.

9. FAIRNESS.
Be encouraging but academically rigorous. Do not inflate marks
just to be encouraging, and do not make the marking unnecessarily
harsh.

Award marks for demonstrated knowledge, not for writing style,
grammar, spelling, or exact phrases, unless the wording changes
the medical meaning.

10. OUTPUT.
Return only the required structured JSON matching the supplied schema.
Keep feedback concise, clear, and educational.
`;

  const userContent = `
QUESTION (${maximum} marks):
${String(questionText || '').trim()}

MARKING GUIDE / RUBRIC:
${rubricText || '(No separate marking scheme supplied)'}

MODEL ANSWER:
${referenceText || '(No separate model answer supplied)'}

ADDITIONAL EXPLANATION:
${explanationText || '(None supplied)'}

STUDENT ANSWER:
${studentText}

Now mark the student's answer fairly.

Important:
- Assess the actual medical meaning of the student's answer.
- Award marks for every relevant correct concept demonstrated.
- Use partial marks when the knowledge is incomplete.
- Explain the marks awarded for each important criterion.
- Identify correct, partially correct, missing, and incorrect points.
- Do not require exact wording from the model answer.
- Do not invent extra requirements.
- The criteria must cover the important assessable points without
  double-counting.
- The sum of marks_awarded must equal awarded.
- The sum of marks_available must equal ${maximum}.
- The awarded score must be between 0 and ${maximum}.
`;

  const response = await fetch(
    'https://api.openai.com/v1/responses',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: env.OPENAI_MARKING_MODEL || 'gpt-4.1-mini',
        store: false,
        instructions,
        input: userContent,
        text: {
          format: {
            type: 'json_schema',
            name: 'medical_saq_marking',
            strict: true,
            schema
          }
        },
        max_output_tokens: 2000
      })
    }
  );

  const raw = await response.text();

  let payload;

  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail =
      payload?.error?.message ||
      `OpenAI returned HTTP ${response.status}`;

    console.error(
      'OpenAI marking request failed:',
      response.status,
      detail
    );

    throw new Error(`AI marking service failed: ${detail}`);
  }

  const outputText = (payload?.output || [])
    .flatMap(item => item?.content || [])
    .filter(part => part?.type === 'output_text')
    .map(part => part.text || '')
    .join('');

  if (!outputText) {
    throw new Error(
      'AI marking service returned no marking result.'
    );
  }

  let result;

  try {
    result = JSON.parse(outputText);
  } catch {
    throw new Error(
      'AI marking service returned an unreadable marking result.'
    );
  }

  const safeCriteria = Array.isArray(result.criteria)
    ? result.criteria.map(c => {
        const available = Math.max(
          0,
          Number(c.marks_available) || 0
        );

        const awarded = Math.max(
          0,
          Math.min(
            available,
            Number(c.marks_awarded) || 0
          )
        );

        return {
          criterion: String(
            c.criterion || 'Assessment point'
          ),
          status: [
            'correct',
            'partially correct',
            'missing',
            'incorrect'
          ].includes(c.status)
            ? c.status
            : 'partially correct',
          marks_awarded:
            Math.round(awarded * 100) / 100,
          marks_available:
            Math.round(available * 100) / 100,
          explanation: String(c.explanation || '')
        };
      })
    : [];

  // Enforce the question maximum and keep the score consistent
  // with the criterion-by-criterion marks.
  let criteriaTotal = safeCriteria.reduce(
    (sum, c) => sum + c.marks_awarded,
    0
  );

  criteriaTotal = Math.round(criteriaTotal * 100) / 100;

  let awarded = Math.round(
    Math.min(
      maximum,
      Math.max(0, criteriaTotal)
    ) * 100
  ) / 100;

  // Make the available criterion marks add up to the question maximum.
  const availableTotal = safeCriteria.reduce(
    (sum, c) => sum + c.marks_available,
    0
  );

  if (
    safeCriteria.length > 0 &&
    Math.abs(availableTotal - maximum) > 0.01
  ) {
    if (availableTotal > 0) {
      const factor = maximum / availableTotal;

      for (const c of safeCriteria) {
        c.marks_available =
          Math.round(c.marks_available * factor * 100) / 100;

        c.marks_awarded =
          Math.round(
            Math.min(
              c.marks_available,
              c.marks_awarded * factor
            ) * 100
          ) / 100;
      }
    } else {
      safeCriteria[0].marks_available = maximum;
      safeCriteria[0].marks_awarded = awarded;
    }

    criteriaTotal = safeCriteria.reduce(
      (sum, c) => sum + c.marks_awarded,
      0
    );

    awarded = Math.round(
      Math.min(maximum, criteriaTotal) * 100
    ) / 100;
  }

  const detailLines = safeCriteria.map(c =>
    `• ${c.criterion}: ${c.marks_awarded}/${c.marks_available} (${c.status}) — ${c.explanation}`
  );

  const feedback = [
    String(
      result.feedback ||
      'Review the criterion-by-criterion feedback below.'
    ),
    detailLines.length
      ? detailLines.join('\n')
      : ''
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    awarded,
    maximum,
    feedback,
    criteria: safeCriteria
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = makeCorsHeaders(request);

  if (request.method === 'OPTIONS') {
    return reply(204, null, corsHeaders);
  }

  if (request.method !== 'POST') {
    return reply(
      405,
      { error: 'Use POST for Pathology marking.' },
      corsHeaders
    );
  }

  if (
    !env.SUPABASE_URL ||
    !env.SUPABASE_SECRET_KEY ||
    !env.SUPABASE_PUBLISHABLE_KEY ||
    !env.OPENAI_API_KEY
  ) {
    return reply(
      500,
      {
        error:
          'Server configuration is incomplete. Check SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY and OPENAI_API_KEY in Cloudflare Pages Variables and Secrets.'
      },
      corsHeaders
    );
  }

  try {
    const authHeader =
      request.headers.get('Authorization') || '';

    const accessToken = authHeader
      .replace(/^Bearer\s+/i, '')
      .trim();

    if (!accessToken) {
      return reply(
        401,
        { error: 'Please sign in again.' },
        corsHeaders
      );
    }

    // Verify the student's Supabase session.
    const authResponse = await fetch(
      `${env.SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!authResponse.ok) {
      return reply(
        401,
        {
          error:
            'Your session could not be verified. Please sign in again.'
        },
        corsHeaders
      );
    }

    const user = await authResponse.json();

    if (!user?.id) {
      return reply(
        401,
        { error: 'Unable to verify your account.' },
        corsHeaders
      );
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return reply(
        400,
        { error: 'Invalid request body.' },
        corsHeaders
      );
    }

    const attemptId = body.attempt_id || body.attemptId;

    if (
      typeof attemptId !== 'string' ||
      !attemptId.trim()
    ) {
      return reply(
        400,
        { error: 'Missing attempt_id.' },
        corsHeaders
      );
    }

    const attempts = await supabaseRequest(
      env,
      `attempts?id=eq.${encodeURIComponent(attemptId)}&select=id,user_id,quiz_id,status,score,total_marks,submitted_at`
    );

    const attempt = attempts?.[0];

    if (!attempt) {
      return reply(
        404,
        { error: 'Attempt not found.' },
        corsHeaders
      );
    }

    let isAdmin = false;

    try {
      const roles = await supabaseRequest(
        env,
        `user_roles?user_id=eq.${encodeURIComponent(user.id)}&select=role`
      );

      isAdmin =
        Array.isArray(roles) &&
        roles.some(
          r => String(r.role || '').toLowerCase() === 'admin'
        );
    } catch (e) {
      console.warn(
        'Could not check optional admin role; enforcing attempt ownership.',
        e.message
      );
    }

    if (attempt.user_id !== user.id && !isAdmin) {
      return reply(
        403,
        { error: 'You may only mark your own attempt.' },
        corsHeaders
      );
    }

    if (
      String(attempt.status || '').toLowerCase() !== 'submitted'
    ) {
      return reply(
        409,
        { error: 'This attempt has not been submitted yet.' },
        corsHeaders
      );
    }

    const quizzes = await supabaseRequest(
      env,
      `quizzes?id=eq.${encodeURIComponent(attempt.quiz_id)}&select=id,subject,title`
    );

    const quiz = quizzes?.[0];

    if (
      !quiz ||
      !String(quiz.subject || '')
        .toLowerCase()
        .includes('pathology')
    ) {
      return reply(
        400,
        {
          error:
            'This marking function is only for Pathology quizzes.'
        },
        corsHeaders
      );
    }

    const answers = await supabaseRequest(
      env,
      `student_answers?attempt_id=eq.${encodeURIComponent(attempt.id)}&select=id,question_id,answer_text,awarded_marks,feedback,questions(question_text,marks,marking_scheme,correct_answer,explanation,question_order)`
    );

    if (!Array.isArray(answers) || answers.length === 0) {
      return reply(
        400,
        {
          error:
            'No saved answers were found for this attempt.'
        },
        corsHeaders
      );
    }

    answers.sort(
      (a, b) =>
        Number(a.questions?.question_order || 0) -
        Number(b.questions?.question_order || 0)
    );

    const details = [];
    let score = 0;
    let totalMarks = 0;

    for (const answer of answers) {
      const question = answer.questions || {};

      const marked = await markAnswerAI(
        answer.answer_text,
        question.marks,
        question.question_text,
        question.marking_scheme,
        question.correct_answer,
        question.explanation,
        env
      );

      // Save marks and feedback for this student's answer.
      await supabaseRequest(
        env,
        `student_answers?id=eq.${encodeURIComponent(answer.id)}`,
        {
          method: 'PATCH',
          headers: {
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            awarded_marks: marked.awarded,
            feedback: marked.feedback
          })
        }
      );

      score += marked.awarded;
      totalMarks += marked.maximum;

      details.push({
        question_id: answer.question_id,
        question: question.question_text || '',
        awarded_marks: marked.awarded,
        maximum_marks: marked.maximum,
        feedback: marked.feedback
      });
    }

    score = Math.round(score * 100) / 100;
    totalMarks = Math.round(totalMarks * 100) / 100;

    // Save the total score for the attempt.
    await supabaseRequest(
      env,
      `attempts?id=eq.${encodeURIComponent(attempt.id)}`,
      {
        method: 'PATCH',
        headers: {
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({
          score,
          total_marks: totalMarks
        })
      }
    );

    return reply(
      200,
      {
        success: true,
        attempt_id: attempt.id,
        score,
        total_marks: totalMarks,
        percentage:
          totalMarks > 0
            ? Math.round(
                (score / totalMarks) * 10000
              ) / 100
            : 0,
        results: details,
        details
      },
      corsHeaders
    );
  } catch (error) {
    console.error(
      'Pathology automatic marking error:',
      error?.stack || error?.message || error
    );

    return reply(
      500,
      {
        error:
          `Automatic marking failed: ${String(
            error?.message || 'unexpected server error'
          ).slice(0, 500)}. Your saved attempt has not been deleted. Check the error before retrying.`
      },
      corsHeaders
    );
  }
}
