'use strict';

// Netlify Function: deterministic, non-AI marking for submitted Pathology SAQ attempts.
// Required Netlify environment variables: SUPABASE_URL, SUPABASE_SECRET_KEY,
// SUPABASE_PUBLISHABLE_KEY. No Gemini/OpenAI/AI key is used.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const ALLOWED_ORIGIN = 'https://med-quiz-44d140.netlify.app';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function reply(statusCode, data) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(data) };
}

async function supabaseRequest(path, options = {}) {
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

function criterionMatched(answer, criterion) {
  if (!normalize(answer)) return false;
  if (criterion.keywords?.length) return criterion.keywords.some(k => containsPhrase(answer, k));
  const words = normalize(criterion.point).split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));
  if (!words.length) return containsPhrase(answer, criterion.point);
  const hits = words.filter(w => (` ${normalize(answer)} `).includes(` ${w} `)).length;
  const required = words.length <= 2 ? words.length : Math.ceil(words.length * 0.6);
  return hits >= required;
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
    'This is automatic keyword/rubric marking, so valid wording not included in the rubric may be missed. An admin can review borderline answers.'
  ].join(' ');
  return { awarded: earned, maximum, feedback };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Use POST for Pathology marking.' });
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !SUPABASE_PUBLISHABLE_KEY) {
    return reply(500, { error: 'Server configuration is incomplete. Check SUPABASE_URL, SUPABASE_SECRET_KEY and SUPABASE_PUBLISHABLE_KEY in Netlify.' });
  }

  try {
    const authHeader = event.headers?.authorization || event.headers?.Authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!accessToken) return reply(401, { error: 'Please sign in again.' });

    const authResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}` }
    });
    if (!authResponse.ok) return reply(401, { error: 'Your session could not be verified. Please sign in again.' });
    const user = await authResponse.json();
    if (!user?.id) return reply(401, { error: 'Unable to verify your account.' });

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return reply(400, { error: 'Invalid request body.' }); }
    const attemptId = body.attempt_id || body.attemptId;
    if (typeof attemptId !== 'string' || !attemptId.trim()) return reply(400, { error: 'Missing attempt_id.' });

    const attempts = await supabaseRequest(`attempts?id=eq.${encodeURIComponent(attemptId)}&select=id,user_id,quiz_id,status,score,total_marks,submitted_at`);
    const attempt = attempts?.[0];
    if (!attempt) return reply(404, { error: 'Attempt not found.' });

    let isAdmin = false;
    try {
      const roles = await supabaseRequest(`user_roles?user_id=eq.${encodeURIComponent(user.id)}&select=role`);
      isAdmin = Array.isArray(roles) && roles.some(r => String(r.role || '').toLowerCase() === 'admin');
    } catch (e) {
      console.warn('Could not check optional admin role; enforcing attempt ownership.', e.message);
    }
    if (attempt.user_id !== user.id && !isAdmin) return reply(403, { error: 'You may only mark your own attempt.' });
    if (String(attempt.status || '').toLowerCase() !== 'submitted') return reply(409, { error: 'This attempt has not been submitted yet.' });

    const quizzes = await supabaseRequest(`quizzes?id=eq.${encodeURIComponent(attempt.quiz_id)}&select=id,subject,title`);
    const quiz = quizzes?.[0];
    if (!quiz || !String(quiz.subject || '').toLowerCase().includes('pathology')) {
      return reply(400, { error: 'This marking function is only for Pathology quizzes.' });
    }

    const answers = await supabaseRequest(
      `student_answers?attempt_id=eq.${encodeURIComponent(attempt.id)}&select=id,question_id,answer_text,awarded_marks,feedback,questions(question_text,marks,marking_scheme,correct_answer,explanation,question_order)`
    );
    if (!Array.isArray(answers) || answers.length === 0) return reply(400, { error: 'No saved answers were found for this attempt.' });
    answers.sort((a, b) => Number(a.questions?.question_order || 0) - Number(b.questions?.question_order || 0));

    const details = [];
    let score = 0;
    let totalMarks = 0;
    for (const answer of answers) {
      const question = answer.questions || {};
      const marked = markAnswer(answer.answer_text, question.marks, question.marking_scheme || question.correct_answer || '');
      await supabaseRequest(`student_answers?id=eq.${encodeURIComponent(answer.id)}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ awarded_marks: marked.awarded, feedback: marked.feedback })
      });
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
    await supabaseRequest(`attempts?id=eq.${encodeURIComponent(attempt.id)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ score, total_marks: totalMarks })
    });

    return reply(200, {
      success: true, attempt_id: attempt.id, score, total_marks: totalMarks,
      percentage: totalMarks > 0 ? Math.round((score / totalMarks) * 10000) / 100 : 0,
      results: details, details
    });
  } catch (error) {
    console.error('Pathology automatic marking error:', error?.stack || error?.message || error);
    return reply(500, {
      error: `Automatic marking failed: ${String(error?.message || 'unexpected server error').slice(0, 500)}. Your saved attempt has not been deleted; retry from its review page.`
    });
  }
};
