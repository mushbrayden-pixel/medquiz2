'use strict';

// Admin-only Pathology mark review/update endpoint for Cloudflare Pages.
// Required Cloudflare variables: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
// SUPABASE_SECRET_KEY. Never expose SUPABASE_SECRET_KEY in browser code.

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

async function sb(env, path, options = {}) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY || !env.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Server configuration is incomplete.');
  }
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const detail = typeof data === 'string' ? data : (data?.message || data?.hint || 'Database request failed.');
    throw new Error(`Database request failed (${response.status}): ${detail}`);
  }
  return data;
}

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json(405, { error: 'Use POST for admin Pathology mark review.' });
  try {
    const authHeader = request.headers.get('Authorization') || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!accessToken) return json(401, { error: 'Please sign in again.' });

    const auth = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${accessToken}` }
    });
    if (!auth.ok) return json(401, { error: 'Your session could not be verified. Please sign in again.' });
    const user = await auth.json();
    if (!user?.id) return json(401, { error: 'Unable to verify your account.' });

    const roles = await sb(env, `user_roles?user_id=eq.${encodeURIComponent(user.id)}&select=role`);
    if (!Array.isArray(roles) || !roles.some(r => String(r.role || '').toLowerCase() === 'admin')) {
      return json(403, { error: 'Admin access is required to adjust marks.' });
    }

    let body;
    try { body = await request.json(); } catch { return json(400, { error: 'Invalid request body.' }); }
    const action = String(body.action || 'load').toLowerCase();
    const attemptId = String(body.attempt_id || '').trim();
    if (!attemptId) return json(400, { error: 'Missing attempt_id.' });

    const attempts = await sb(env, `attempts?id=eq.${encodeURIComponent(attemptId)}&select=id,user_id,quiz_id,status,score,total_marks,quizzes(id,title,subject)`);
    const attempt = attempts?.[0];
    if (!attempt) return json(404, { error: 'Attempt not found.' });
    if (!String(attempt.quizzes?.subject || '').toLowerCase().includes('pathology')) {
      return json(400, { error: 'Marks can only be adjusted for Pathology attempts.' });
    }
    if (String(attempt.status || '').toLowerCase() !== 'submitted') {
      return json(409, { error: 'Only submitted attempts can be adjusted.' });
    }

    if (action === 'load') {
      const answers = await sb(env, `student_answers?attempt_id=eq.${encodeURIComponent(attemptId)}&select=id,question_id,answer_text,awarded_marks,feedback,questions(question_text,marks,question_order,marking_scheme,correct_answer,explanation)&order=question_id.asc`);
      if (!Array.isArray(answers)) return json(500, { error: 'Could not load saved answers.' });
      answers.sort((a,b) => Number(a.questions?.question_order || 0) - Number(b.questions?.question_order || 0));
      return json(200, {
        success: true,
        attempt: { id: attempt.id, student_id: attempt.user_id, quiz_title: attempt.quizzes?.title || 'Pathology quiz', score: attempt.score, total_marks: attempt.total_marks },
        answers: answers.map(a => ({
          id: a.id,
          question_id: a.question_id,
          question: a.questions?.question_text || '',
          student_answer: a.answer_text || '',
          model_answer: a.questions?.marking_scheme || a.questions?.correct_answer || '',
          awarded_marks: Number(a.awarded_marks || 0),
          maximum_marks: Math.max(0, Number(a.questions?.marks || 0)),
          feedback: a.feedback || '',
          explanation: a.questions?.explanation || ''
        }))
      });
    }

    if (action === 'update') {
      const changes = Array.isArray(body.changes) ? body.changes : [];
      if (!changes.length) return json(400, { error: 'No mark changes were supplied.' });
      if (changes.length > 100) return json(400, { error: 'Too many mark changes in one request.' });

      const answers = await sb(env, `student_answers?attempt_id=eq.${encodeURIComponent(attemptId)}&select=id,awarded_marks,questions(marks)`);
      const answerMap = new Map((answers || []).map(a => [String(a.id), a]));
      const seen = new Set();
      for (const change of changes) {
        const id = String(change.answer_id || '');
        if (!id || seen.has(id)) return json(400, { error: 'Each answer must appear only once in the changes.' });
        seen.add(id);
        const answer = answerMap.get(id);
        if (!answer) return json(400, { error: 'An answer does not belong to this attempt.' });
        const max = Math.max(0, Number(answer.questions?.marks || 0));
        const marks = Number(change.awarded_marks);
        if (!Number.isFinite(marks) || marks < 0 || marks > max) {
          return json(400, { error: `Marks must be between 0 and ${max}.` });
        }
        const rounded = Math.round(marks * 100) / 100;
        await sb(env, `student_answers?id=eq.${encodeURIComponent(id)}&attempt_id=eq.${encodeURIComponent(attemptId)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ awarded_marks: rounded })
        });
        answer.awarded_marks = rounded;
      }

      // Re-read all answers and recompute the saved attempt score from persisted marks.
      const finalAnswers = await sb(env, `student_answers?attempt_id=eq.${encodeURIComponent(attemptId)}&select=awarded_marks,questions(marks)`);
      const score = Math.round((finalAnswers || []).reduce((sum, a) => sum + Math.max(0, Number(a.awarded_marks || 0)), 0) * 100) / 100;
      const total = Math.round((finalAnswers || []).reduce((sum, a) => sum + Math.max(0, Number(a.questions?.marks || 0)), 0) * 100) / 100;
      await sb(env, `attempts?id=eq.${encodeURIComponent(attemptId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ score, total_marks: total })
      });
      return json(200, { success: true, attempt_id: attemptId, score, total_marks: total, percentage: total > 0 ? Math.round((score / total) * 10000) / 100 : 0 });
    }

    return json(400, { error: 'Unknown action. Use load or update.' });
  } catch (error) {
    console.error('Admin Pathology marks endpoint error:', error?.stack || error?.message || error);
    return json(500, { error: String(error?.message || 'Unexpected server error').slice(0, 500) });
  }
}
