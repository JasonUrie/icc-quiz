import { createHash } from "node:crypto";

const SUPABASE_URL =
  process.env.ICC_QUIZ_SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.ICC_QUIZ_SUPABASE_SECRET_KEY;

const COOKIE_NAME = "__Host-icc_quiz_session";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

function getCookie(req, name) {
  const cookieHeader =
    req.headers.get("cookie") || "";

  for (const cookie of cookieHeader.split(";")) {
    const trimmed = cookie.trim();
    const separator = trimmed.indexOf("=");

    if (separator === -1) continue;

    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);

    if (key === name) return value;
  }

  return null;
}

function hashSessionToken(token) {
  return createHash("sha256")
    .update(token)
    .digest("hex");
}

async function supabase(path, options = {}) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        "content-type": "application/json",
        ...(options.headers ?? {}),
      },
    }
  );

  const text = await response.text();

  if (!response.ok) {
    console.error(
      "Supabase error:",
      response.status,
      text
    );

    throw new Error(
      "Erreur de base de données."
    );
  }

  return text ? JSON.parse(text) : null;
}

async function getSession(tokenHash) {
  const params = new URLSearchParams({
    token_hash: `eq.${tokenHash}`,
    select: "user_id,expires_at",
    limit: "1",
  });

  const rows = await supabase(
    `user_sessions?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function getUser(userId) {
  const params = new URLSearchParams({
    id: `eq.${userId}`,
    select: "id,unit_id",
    limit: "1",
  });

  const rows = await supabase(
    `users?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function getQuiz(quizId) {
  const params = new URLSearchParams({
    id: `eq.${quizId}`,
    is_published: "eq.true",
    select:
      "id,title,slug,unit_id,max_score,content,content_version",
    limit: "1",
  });

  const rows = await supabase(
    `quizzes?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function getAttempt(
  userId,
  quizId
) {
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    quiz_id: `eq.${quizId}`,
    select:
      "id,status,score,percentage,trophy,points,completed_at",
    limit: "1",
  });

  const rows = await supabase(
    `attempts?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toUpperCase();
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .map((item) =>
            String(item).trim()
          )
          .filter(Boolean)
      ),
    ].sort();
  }

  if (
    value !== undefined &&
    value !== null &&
    String(value).trim()
  ) {
    return [
      String(value).trim(),
    ];
  }

  return [];
}

function hasAnswer(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (
    value === null ||
    value === undefined
  ) {
    return false;
  }

  return String(value).trim().length > 0;
}

function evaluateQuestion(
  question,
  answer
) {
  const evaluation =
    question.evaluation;

  if (!evaluation?.mode) {
    throw new Error(
      `Configuration manquante pour ${question.id}.`
    );
  }

  if (
    evaluation.mode ===
    "exact_set"
  ) {
    const submitted =
      normalizeArray(answer);

    const correct =
      normalizeArray(
        evaluation.correct
      );

    return (
      submitted.length ===
        correct.length &&
      submitted.every(
        (value, index) =>
          value === correct[index]
      )
    );
  }

  if (
    evaluation.mode ===
    "normalized_text"
  ) {
    const submitted =
      normalizeText(answer);

    const accepted =
      (
        evaluation.accepted ?? []
      ).map(normalizeText);

    return accepted.includes(
      submitted
    );
  }

  if (
    evaluation.mode ===
    "any_nonempty"
  ) {
    return hasAnswer(answer);
  }

  throw new Error(
    `Mode d'évaluation inconnu pour ${question.id}.`
  );
}

function calculateReward(
  score,
  maxScore
) {
  const percentage =
    Math.round(
      (score / maxScore) *
        10000
    ) / 100;

  if (score === maxScore) {
    return {
      percentage,
      trophy: "gold",
      points: 3,
    };
  }

  if (percentage >= 80) {
    return {
      percentage,
      trophy: "silver",
      points: 2,
    };
  }

  if (percentage >= 50) {
    return {
      percentage,
      trophy: "bronze",
      points: 1,
    };
  }

  return {
    percentage,
    trophy: "none",
    points: 0,
  };
}

async function saveAnswers(
  attemptId,
  questions,
  answers,
  results
) {
  const rows =
    questions.map(
      (question) => ({
        attempt_id:
          attemptId,

        question_key:
          question.id,

        answer_data: {
          value:
            answers[
              question.id
            ],
        },

        is_correct:
          results[
            question.id
          ],
      })
    );

  await supabase(
    "attempt_answers?on_conflict=attempt_id,question_key",
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=minimal",
      },

      body:
        JSON.stringify(rows),
    }
  );
}

async function completeAttempt(
  attemptId,
  result
) {
  const params =
    new URLSearchParams({
      id: `eq.${attemptId}`,
      status: "eq.started",
    });

  return await supabase(
    `attempts?${params.toString()}`,
    {
      method: "PATCH",

      headers: {
        Prefer:
          "return=representation",
      },

      body:
        JSON.stringify({
          status: "completed",
          score:
            result.score,
          percentage:
            result.percentage,
          trophy:
            result.trophy,
          points:
            result.points,
          completed_at:
            new Date().toISOString(),
        }),
    }
  );
}

export default async (req) => {
  if (req.method !== "POST") {
    return json(
      {
        error:
          "Méthode non autorisée.",
      },
      405
    );
  }

  if (
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    return json(
      {
        error:
          "Configuration serveur incomplète.",
      },
      500
    );
  }

  try {
    const token =
      getCookie(
        req,
        COOKIE_NAME
      );

    if (!token) {
      return json(
        {
          ok: false,
          authenticated: false,
        },
        401
      );
    }

    const session =
      await getSession(
        hashSessionToken(token)
      );

    if (
      !session ||
      new Date(
        session.expires_at
      ).getTime() <= Date.now()
    ) {
      return json(
        {
          ok: false,
          authenticated: false,
        },
        401
      );
    }

    const body =
      await req.json();

    const quizId =
      String(
        body.quizId ?? ""
      ).trim();

    const answers =
      body.answers;

    if (
      !quizId ||
      !answers ||
      typeof answers !==
        "object"
    ) {
      return json(
        {
          error:
            "Données du quiz incomplètes.",
        },
        400
      );
    }

    const [user, quiz] =
      await Promise.all([
        getUser(
          session.user_id
        ),
        getQuiz(quizId),
      ]);

    if (!user) {
      return json(
        {
          error:
            "Utilisateur introuvable.",
        },
        404
      );
    }

    if (!quiz) {
      return json(
        {
          error:
            "Quiz introuvable.",
        },
        404
      );
    }

    if (
      quiz.unit_id &&
      quiz.unit_id !==
        user.unit_id
    ) {
      return json(
        {
          error:
            "Ce quiz n'est pas disponible pour votre unité.",
        },
        403
      );
    }

    const questions =
      quiz.content
        ?.questions;

    if (
      !Array.isArray(
        questions
      ) ||
      questions.length === 0
    ) {
      return json(
        {
          error:
            "Le contenu de ce quiz est indisponible.",
        },
        500
      );
    }

    if (
      Number(
        quiz.max_score
      ) !== questions.length
    ) {
      return json(
        {
          error:
            "La configuration du score du quiz est incohérente.",
        },
        500
      );
    }

    const attempt =
      await getAttempt(
        user.id,
        quiz.id
      );

    if (!attempt) {
      return json(
        {
          error:
            "Commencez le quiz avant de le terminer.",
        },
        400
      );
    }

    if (
      attempt.status ===
      "completed"
    ) {
      return json(
        {
          ok: false,
          alreadyCompleted: true,

          result: {
            score:
              attempt.score,
            maxScore:
              Number(
                quiz.max_score
              ),
            percentage:
              Number(
                attempt.percentage
              ),
            trophy:
              attempt.trophy,
            points:
              attempt.points,
          },
        },
        409
      );
    }

    const missing =
      questions
        .filter(
          (question) =>
            !hasAnswer(
              answers[
                question.id
              ]
            )
        )
        .map(
          (question) =>
            question.id
        );

    if (missing.length) {
      return json(
        {
          error:
            "Toutes les questions doivent recevoir une réponse.",
          missingQuestions:
            missing,
        },
        400
      );
    }

    const results = {};
    let score = 0;

    for (
      const question
      of questions
    ) {
      const correct =
        evaluateQuestion(
          question,
          answers[
            question.id
          ]
        );

      results[
        question.id
      ] = correct;

      if (correct) {
        score += 1;
      }
    }

    const maxScore =
      questions.length;

    const reward =
      calculateReward(
        score,
        maxScore
      );

    const result = {
      score,
      maxScore,
      percentage:
        reward.percentage,
      trophy:
        reward.trophy,
      points:
        reward.points,
    };

    await saveAnswers(
      attempt.id,
      questions,
      answers,
      results
    );

    const updated =
      await completeAttempt(
        attempt.id,
        result
      );

    if (
      !updated ||
      updated.length === 0
    ) {
      const existing =
        await getAttempt(
          user.id,
          quiz.id
        );

      return json(
        {
          ok: false,
          alreadyCompleted: true,

          result: {
            score:
              existing?.score,
            maxScore,
            percentage:
              Number(
                existing?.percentage
              ),
            trophy:
              existing?.trophy,
            points:
              existing?.points,
          },
        },
        409
      );
    }

    return json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error(
      "Attempt complete error:",
      error
    );

    return json(
      {
        error:
          "Impossible de terminer le quiz.",
      },
      500
    );
  }
};

export const config = {
  path:
    "/api/attempts/complete",
};
