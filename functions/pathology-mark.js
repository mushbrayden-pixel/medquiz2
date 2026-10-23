'use strict';

// Cloudflare Pages Function: deterministic, non-AI Pathology SAQ marking.
// Configure SUPABASE_URL, SUPABASE_SECRET_KEY (secret), and SUPABASE_PUBLISHABLE_KEY
// in Cloudflare Pages > Settings > Variables and Secrets.

function makeCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const requestOrigin = new URL(request.url).origin;
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  // Only reflect the same origin as this Pages deployment.
  if (origin && origin === requestOrigin) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function reply(status, data, headers) {
  return new Response(data === null ? null : JSON.stringify(data), { status, headers });
}

async function supabaseRequest(env, path, options = {}) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = env.SUPABASE_SECRET_KEY;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) throw new Error('Supabase server configuration is missing.');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    console.error('Supabase request failed:', response.status, typeof data === 'string' ? data : JSON.stringify(data));
    const detail = typeof data === 'string' ? data : (data?.message || data?.hint || 'Database request failed.');
    throw new Error(`Database request failed (${response.status}): ${detail}`);
  }
  return data;
}

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function containsPhrase(answer, phrase) {
  const a = ` ${normalize(answer)} `;
  const p = normalize(phrase);
  return !!p && a.includes(` ${p} `);
}

const STOP_WORDS = new Set([
  'the','and','or','of','to','in','a','an','is','are','was','were','be','by','for','with',
  'after','before','may','can','this','that','into','from','on','as','it','their','its','due',
  'which','when','during','involves','involved','occurs','occur','increase','increased'
]);

function extractLegacyPoints(scheme) {
  const text = String(scheme || '').trim();
  if (!text) return [];
  // Existing quizzes often store model answers as numbered or bulleted points.
  let parts = text
    .replace(/\r/g, '\n')
    .split(/\n+|(?=(?:^|\s)(?:\d{1,2}[.)]|[-•*])\s+)/)
    .map(x => x.replace(/^\s*(?:\d{1,2}[.)]|[-•*])\s*/, '').trim())
    .filter(Boolean);
  if (parts.length < 2) {
    parts = text.split(/;|\.(?:\s+|$)/).map(x => x.trim()).filter(Boolean);
  }
  // A single unstructured paragraph cannot be graded reliably by keyword rules.
  // Still create one criterion rather than fabricate multiple separate points.
  return parts.map(point => ({ point, keywords: [] }));
}

function parseRubric(scheme, maxMarks) {
  let parsed = null;
  if (typeof scheme === 'string') {
    try { parsed = JSON.parse(scheme); } catch { /* legacy free-text model answer */ }
  }
  let points = Array.isArray(parsed) ? parsed : extractLegacyPoints(scheme);
  points = points.map((item, i) => {
    if (typeof item === 'string') return { point: item, keywords: [], marks: null, index: i };
    return {
      point: String(item?.point || item?.concept || item?.criterion || '').trim(),
      keywords: Array.isArray(item?.keywords) ? item.keywords.map(String).filter(x => x.trim()) : [],
      marks: Number.isFinite(Number(item?.marks)) && Number(item?.marks) > 0 ? Number(item.marks) : null,
      index: i
    };
  }).filter(p => p.point);

  if (!points.length) {
    return [{ point: 'Relevant answer based on the model answer', keywords: [], marks: Number(maxMarks) || 0, index: 0, generic: true }];
  }
  const explicitTotal = points.reduce((sum, p) => sum + (p.marks || 0), 0);
  if (points.some(p => p.marks === null) || explicitTotal <= 0) {
    const each = (Number(maxMarks) || 0) / points.length;
    points.forEach(p => { p.marks = each; });
  } else if (Math.abs(explicitTotal - maxMarks) > 0.001 && explicitTotal > 0) {
    // Keep total awarded marks aligned with the question's configured maximum.
    points.forEach(p => { p.marks = p.marks * maxMarks / explicitTotal; });
  }
  return points;
}

// Synonym expansion for common medical wording. This remains deterministic and uses no AI.
const SYNONYM_GROUPS = [
  ['dyspnoea', 'dyspnea', 'shortness of breath', 'breathlessness'],
  ['oedema', 'edema', 'swelling'],
  ['haemolysis', 'hemolysis', 'red cell destruction'],
  ['fibrosis', 'scarring', 'fibrous tissue'],
  ['inflammation', 'inflammatory response'],
  ['molecular mimicry', 'cross reactivity', 'cross-reactivity', 'antigenic similarity'],
  ['streptococcus pyogenes', 'group a streptococcus', 'group a beta haemolytic streptococcus', 'group a beta hemolytic streptococcus', 'gas'],
  ['mitral stenosis', 'narrowing of the mitral valve'],
  ['valvular deformity', 'valve deformity', 'damaged valve', 'valve damage'],
  ['heart failure', 'cardiac failure', 'congestive heart failure'],
  ['atrial fibrillation', 'af'],
  ['thromboembolism', 'embolism due to a blood clot'],
  ['autoimmune', 'immune mediated', 'immune-mediated'],
  ['antibiotic prophylaxis', 'preventive antibiotics', 'long term antibiotics', 'long-term antibiotics']
];

function expandedAnswer(answer) {
  let text = ` ${normalize(answer)} `;
  for (const group of SYNONYM_GROUPS) {
    const normalized = group.map(normalize);
    if (normalized.some(term => term && text.includes(` ${term} `))) {
      text += ` ${normalized.join(' ')} `;
    }
  }
  return text.replace(/\s+/g, ' ');
}

function criterionMatched(answer, criterion) {
  const normalizedAnswer = normalize(answer);
  if (!normalizedAnswer) return false;
  const expanded = expandedAnswer(answer);

  // If a rubric has explicit keywords, accept any keyword or its known synonym.
  if (criterion.keywords?.length) {
    return criterion.keywords.some(k => {
      const key = normalize(k);
      return !!key && expanded.includes(` ${key} `);
    });
  }

  const words = normalize(criterion.point).split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));
  if (!words.length) return expanded.includes(` ${normalize(criterion.point)} `);
  const hits = words.filter(w => expanded.includes(` ${w} `)).length;
  // Short criteria require stronger matching; longer criteria allow partial credit.
  const required = words.length <= 2 ? words.length : Math.max(2, Math.ceil(words.length * 0.5));
  return hits >= Math.min(required, words.length);
}

function markAnswer(answer, maxMarks, scheme) {
  const studentText = String(answer || '').trim();
  const maximum = Math.max(0, Number(maxMarks) || 0);
  const rubric = parseRubric(scheme, maximum);
  if (!studentText) {
    return { awarded: 0, maximum, feedback: 'No answer was entered. Review the marking points and try to include each required concept.' };
  }
  let earned = 0;
  const achieved = [];
  const missed = [];
  for (const point of rubric) {
    const matched = criterionMatched(studentText, point);
    if (matched) {
      earned += point.marks;
      achieved.push(point.point);
    } else {
      missed.push(point.point);
    }
  }
  earned = Math.round(Math.min(maximum, Math.max(0, earned)) * 100) / 100;
  const feedback = [
    achieved.length ? `Recognised points: ${achieved.join('; ')}.` : 'No marking points were recognised by the keyword rules.',
    missed.length ? `Points not recognised: ${missed.join('; ')}.` : 'All configured marking points were recognised.',
    'This is deterministic key-point marking with accepted medical synonyms. Unusual wording may still need an admin review.'
  ].join(' ');
  return { awarded: earned, maximum, feedback };
}

export async function onRequest(context) {
  const { request, env } = context;
  const corsHeaders = makeCorsHeaders(request);
  if (request.method === 'OPTIONS') return reply(204, null, corsHeaders);
  if (request.method !== 'POST') return reply(405, { error: 'Use POST for Pathology marking.' }, corsHeaders);
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !env.SUPABASE_PUBLISHABLE_KEY) {
    return reply(500, { error: 'Server configuration is incomplete. Check SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_PUBLISHABLE_KEY in Cloudflare Pages Variables and Secrets.' }, corsHeaders);
  }

  try {
    const authHeader = request.headers.get('Authorization') || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!accessToken) return reply(401, { error: 'Please sign in again.' }, corsHeaders);

    const authResponse = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}` }
    });
    if (!authResponse.ok) return reply(401, { error: 'Your session could not be verified. Please sign in again.' }, corsHeaders);
    const user = await authResponse.json();
    if (!user?.id) return reply(401, { error: 'Unable to verify your account.' }, corsHeaders);

    let body;
    try { body = await request.json(); }
    catch { return reply(400, { error: 'Invalid request body.' }, corsHeaders); }
    const attemptId = body.attempt_id || body.attemptId;
    if (typeof attemptId !== 'string' || !attemptId.trim()) return reply(400, { error: 'Missing attempt_id.' }, corsHeaders);

    const attempts = await supabaseRequest(env, `attempts?id=eq.${encodeURIComponent(attemptId)}&select=id,user_id,quiz_id,status,score,total_marks,submitted_at`);
    const attempt = attempts?.[0];
    if (!attempt) return reply(404, { error: 'Attempt not found.' }, corsHeaders);

    let isAdmin = false;
    try {
      const roles = await supabaseRequest(env, `user_roles?user_id=eq.${encodeURIComponent(user.id)}&select=role`);
      isAdmin = Array.isArray(roles) && roles.some(r => String(r.role || '').toLowerCase() === 'admin');
    } catch (e) {
      console.warn('Could not check optional admin role; enforcing attempt ownership.', e.message);
    }
    if (attempt.user_id !== user.id && !isAdmin) return reply(403, { error: 'You may only mark your own attempt.' }, corsHeaders);
    if (String(attempt.status || '').toLowerCase() !== 'submitted') return reply(409, { error: 'This attempt has not been submitted yet.' }, corsHeaders);

    const quizzes = await supabaseRequest(env, `quizzes?id=eq.${encodeURIComponent(attempt.quiz_id)}&select=id,subject,title`);
    const quiz = quizzes?.[0];
    if (!quiz || !String(quiz.subject || '').toLowerCase().includes('pathology')) {
      return reply(400, { error: 'This marking function is only for Pathology quizzes.' }, corsHeaders);
    }

    const answers = await supabaseRequest(env, `student_answers?attempt_id=eq.${encodeURIComponent(attempt.id)}&select=id,question_id,answer_text,awarded_marks,feedback,questions(question_text,marks,marking_scheme,correct_answer,explanation,question_order)`);
    if (!Array.isArray(answers) || answers.length === 0) return reply(400, { error: 'No saved answers were found for this attempt.' }, corsHeaders);
    answers.sort((a, b) => Number(a.questions?.question_order || 0) - Number(b.questions?.question_order || 0));

    const details = [];
    let score = 0;
    let totalMarks = 0;
    for (const answer of answers) {
      const question = answer.questions || {};
      const marked = markAnswer(answer.answer_text, question.marks, question.marking_scheme || question.correct_answer || '');
      await supabaseRequest(env, `student_answers?id=eq.${encodeURIComponent(answer.id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ awarded_marks: marked.awarded, feedback: marked.feedback })
      });
      score += marked.awarded;
      totalMarks += marked.maximum;
      details.push({
        question_id: answer.question_id,
        question: question.question_text || '',
        student_answer: answer.answer_text || '',
        model_answer: question.marking_scheme || question.correct_answer || '',
        correct_answer: question.correct_answer || question.marking_scheme || '',
        explanation: question.explanation || marked.feedback,
        awarded_marks: marked.awarded,
        maximum_marks: marked.maximum,
        feedback: marked.feedback
      });
    }

    score = Math.round(score * 100) / 100;
    totalMarks = Math.round(totalMarks * 100) / 100;
    await supabaseRequest(env, `attempts?id=eq.${encodeURIComponent(attempt.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ score, total_marks: totalMarks })
    });

    return reply(200, { success: true, attempt_id: attempt.id, score, total_marks: totalMarks, percentage: totalMarks > 0 ? Math.round((score / totalMarks) * 10000) / 100 : 0, results: details, details }, corsHeaders);
  } catch (error) {
    console.error('Pathology automatic marking error:', error?.stack || error?.message || error);
    return reply(500, { error: `Automatic marking failed: ${String(error?.message || 'unexpected server error').slice(0, 500)}. Your saved attempt has not been deleted; retry from its review page.` }, corsHeaders);
  }
}