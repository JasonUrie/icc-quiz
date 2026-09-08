import { createHash } from "node:crypto";

const SUPABASE_URL =
  process.env.ICC_QUIZ_SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.ICC_QUIZ_SUPABASE_SECRET_KEY;

const COOKIE_NAME = "__Host-icc_quiz_session";

const CURRENT_QUIZ_SLUG =
  "travail-de-fond-gagneur-ames-2026-09-06";

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

    if (key === name) {
      return value;
    }
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
      "id,title,slug,unit_id,max_score",
    limit: "1",
  });

  const rows = await supabase(
    `quizzes?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function getAttempt(userId, quizId) {
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
  if (!Array.isArray(value)) {
    return value == null || value === ""
      ? []
      : [String(value)];
  }

  return [...new Set(
    value.map(String)
  )].sort();
}

function sameAnswers(answer, expected) {
  const actual =
    normalizeArray(answer);

  const correct =
    [...expected].sort();

  return (
    actual.length === correct.length &&
    actual.every(
      (value, index) =>
        value === correct[index]
    )
  );
}

function hasAnswer(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return String(value ?? "").trim() !== "";
}

function evaluateAnswers(answers) {
  const required = [
    "q1",
    "q2",
    "q3",
    "q4",
    "q5",
    "q6",
    "q7",
    "q8",
    "q9",
    "q10",
  ];

  for (const key of required) {
    if (!hasAnswer(answers[key])) {
      throw new Error(
        `La réponse ${key} est manquante.`
      );
    }
  }

  const results = {
    q1: sameAnswers(
      answers.q1,
      ["A", "C", "E"]
    ),

    q2: sameAnswers(
      answers.q2,
      ["A", "B", "D", "E", "G", "H"]
    ),

    q3: sameAnswers(
      answers.q3,
      ["B"]
    ),

    q4: sameAnswers(
      answers.q4,
      ["A", "B", "C", "D", "E", "F", "G", "I"]
    ),

    q5: sameAnswers(
      answers.q5,
      ["A", "C"]
    ),

    q6: sameAnswers(
      answers.q6,
      ["A", "B", "D"]
    ),

    q7:
      normalizeText(answers.q7) ===
      "LUISE",

    q8: sameAnswers(
      answers.q8,
      ["B"]
    ),

    // Question personnelle :
    // elle vaut 1 point dès qu'au moins
    // un terrain a été sélectionné.
    q9:
      normalizeArray(
        answers.q9
      ).length > 0,

    q10: sameAnswers(
      answers.q10,
      ["A", "B", "C", "D", "E"]
    ),
  };

  const score =
    Object.values(results)
      .filter(Boolean)
      .length;

  return {
    score,
    results,
  };
}

function getReward(score, maxScore) {
  const percentage =
    Math.round(
      (score / maxScore) *
        10000
    ) / 100;

  if (percentage === 100) {
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
  answers,
  results
) {
  const rows =
    Object.entries(results)
      .map(([questionKey, correct]) => ({
        attempt_id: attemptId,
        question_key: questionKey,
        answer_data: {
          value: answers[questionKey],
        },
        is_correct: correct,
      }));

  await supabase(
    "attempt_answers?on_conflict=attempt_id,question_key",
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=minimal",
      },

      body: JSON.stringify(rows),
    }
  );
}

async function completeAttempt(
  attemptId,
  score,
  reward
) {
  const params =
    new URLSearchParams({
      id: `eq.${attemptId}`,
      status: "eq.started",
    });

  const rows = await supabase(
    `attempts?${params.toString()}`,
    {
      method: "PATCH",

      headers: {
        Prefer:
          "return=representation",
      },

      body: JSON.stringify({
        score,
        percentage:
          reward.percentage,
        trophy:
          reward.trophy,
        points:
          reward.points,
        status:
          "completed",
        completed_at:
          new Date().toISOString(),
      }),
    }
  );

  return rows?.[0] ?? null;
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

    const tokenHash =
      hashSessionToken(token);

    const session =
      await getSession(tokenHash);

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

    const user =
      await getUser(
        session.user_id
      );

    if (!user) {
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
      body.answers ?? {};

    if (!quizId) {
      return json(
        {
          error:
            "Identifiant du quiz manquant.",
        },
        400
      );
    }

    const quiz =
      await getQuiz(quizId);

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
      quiz.unit_id !== null &&
      quiz.unit_id !==
        user.unit_id
    ) {
      return json(
        {
          error:
            "Quiz indisponible pour cette unité.",
        },
        403
      );
    }

    if (
      quiz.slug !==
      CURRENT_QUIZ_SLUG
    ) {
      return json(
        {
          error:
            "Le corrigé de ce quiz n'est pas encore disponible.",
        },
        400
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
            "La tentative n'a pas été démarrée.",
        },
        409
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
            percentage:
              attempt.percentage,
            trophy:
              attempt.trophy,
            points:
              attempt.points,
            completedAt:
              attempt.completed_at,
          },
        },
        409
      );
    }

    const evaluation =
      evaluateAnswers(
        answers
      );

    const reward =
      getReward(
        evaluation.score,
        quiz.max_score
      );

    await saveAnswers(
      attempt.id,
      answers,
      evaluation.results
    );

    const completed =
      await completeAttempt(
        attempt.id,
        evaluation.score,
        reward
      );

    if (!completed) {
      return json(
        {
          error:
            "La tentative ne peut plus être modifiée.",
        },
        409
      );
    }

    return json({
      ok: true,

      result: {
        score:
          evaluation.score,

        maxScore:
          quiz.max_score,

        percentage:
          reward.percentage,

        trophy:
          reward.trophy,

        points:
          reward.points,
      },
    });
  } catch (error) {
    console.error(
      "Attempt complete error:",
      error
    );

    return json(
      {
        error:
          error?.message ||
          "Impossible de terminer le quiz.",
      },
      400
    );
  }
};

export const config = {
  path:
    "/api/attempts/complete",
};
