import { createHash } from "node:crypto";

const SUPABASE_URL =
  process.env.ICC_QUIZ_SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.ICC_QUIZ_SUPABASE_SECRET_KEY;

const COOKIE_NAME =
  "__Host-icc_quiz_session";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type":
        "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

function getCookie(req, name) {
  const header =
    req.headers.get("cookie") || "";

  for (const cookie of header.split(";")) {
    const trimmed = cookie.trim();
    const separator = trimmed.indexOf("=");

    if (separator === -1) continue;

    const key =
      trimmed.slice(0, separator);

    const value =
      trimmed.slice(separator + 1);

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

async function supabase(
  path,
  options = {}
) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: {
        apikey:
          SUPABASE_SECRET_KEY,

        "content-type":
          "application/json",

        ...(options.headers ?? {}),
      },
    }
  );

  const text =
    await response.text();

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

  return text
    ? JSON.parse(text)
    : null;
}

async function getSession(tokenHash) {
  const params =
    new URLSearchParams({
      token_hash:
        `eq.${tokenHash}`,

      select:
        "user_id,expires_at",

      limit: "1",
    });

  const rows =
    await supabase(
      `user_sessions?${params.toString()}`
    );

  return rows?.[0] ?? null;
}

async function getUser(userId) {
  const params =
    new URLSearchParams({
      id: `eq.${userId}`,
      select: "id,unit_id",
      limit: "1",
    });

  const rows =
    await supabase(
      `users?${params.toString()}`
    );

  return rows?.[0] ?? null;
}

async function getQuiz(quizId) {
  const params =
    new URLSearchParams({
      id: `eq.${quizId}`,
      is_published: "eq.true",

      select:
        "id,unit_id,max_score,content",

      limit: "1",
    });

  const rows =
    await supabase(
      `quizzes?${params.toString()}`
    );

  return rows?.[0] ?? null;
}

async function getAttempt(
  userId,
  quizId
) {
  const params =
    new URLSearchParams({
      user_id:
        `eq.${userId}`,

      quiz_id:
        `eq.${quizId}`,

      select:
        "id,status,score,percentage,trophy,points,completed_at",

      limit: "1",
    });

  const rows =
    await supabase(
      `attempts?${params.toString()}`
    );

  return rows?.[0] ?? null;
}

async function getLockedAnswers(
  attemptId
) {
  const params =
    new URLSearchParams({
      attempt_id:
        `eq.${attemptId}`,

      select:
        "question_key,is_correct",
    });

  return await supabase(
    `attempt_answers?${params.toString()}`
  );
}

function calculateReward(
  score,
  maxScore
) {
  const percentage =
    Math.round(
      (score / maxScore) * 10000
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
          status:
            "completed",

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
    /*
      1. Session
    */

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

    /*
      2. Seulement quizId
      est envoyé par le navigateur.
    */

    const body =
      await req.json();

    const quizId =
      String(
        body.quizId ?? ""
      ).trim();

    if (!quizId) {
      return json(
        {
          error:
            "Quiz manquant.",
        },
        400
      );
    }

    /*
      3. Utilisateur + quiz
    */

    const [user, quiz] =
      await Promise.all([
        getUser(
          session.user_id
        ),

        getQuiz(
          quizId
        ),
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

    /*
      4. Questions officielles
    */

    const questions =
      quiz.content?.questions;

    if (
      !Array.isArray(
        questions
      ) ||
      questions.length === 0
    ) {
      return json(
        {
          error:
            "Contenu du quiz indisponible.",
        },
        500
      );
    }

    const maxScore =
      questions.length;

    if (
      Number(
        quiz.max_score
      ) !== maxScore
    ) {
      return json(
        {
          error:
            "Configuration du score incohérente.",
        },
        500
      );
    }

    /*
      5. Tentative
    */

    const attempt =
      await getAttempt(
        user.id,
        quiz.id
      );

    if (!attempt) {
      return json(
        {
          error:
            "Le quiz doit d'abord être commencé.",
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

            maxScore,

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

    /*
      6. Lecture des réponses
      verrouillées
    */

    const answerRows =
      await getLockedAnswers(
        attempt.id
      );

    const answerMap =
      new Map(
        answerRows.map(
          (row) => [
            row.question_key,
            row,
          ]
        )
      );

    /*
      Vérifie qu'il existe
      une réponse pour chacune
      des questions du quiz.
    */

    const missingQuestions =
      questions
        .filter(
          (question) =>
            !answerMap.has(
              question.id
            )
        )
        .map(
          (question) =>
            question.id
        );

    if (
      missingQuestions.length > 0
    ) {
      return json(
        {
          ok: false,

          incomplete: true,

          error:
            "Toutes les questions doivent être validées avant de terminer le quiz.",

          answered:
            maxScore -
            missingQuestions.length,

          total:
            maxScore,

          missingQuestions,
        },
        400
      );
    }

    /*
      7. Calcul du score
      uniquement depuis Supabase
    */

    let score = 0;

    for (
      const question
      of questions
    ) {
      const saved =
        answerMap.get(
          question.id
        );

      if (
        saved?.is_correct ===
        true
      ) {
        score += 1;
      }
    }

    /*
      8. Trophée + points
    */

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

    /*
      9. Fermeture définitive
      de la tentative
    */

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

    /*
      10. Écran de fin :
      uniquement résultat.

      Aucune correction détaillée
      n'est renvoyée ici.
    */

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
