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
        [
          "id",
          "title",
          "slug",
          "unit_id",
          "week_start",
          "max_score",
          "content",
        ].join(","),

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
        [
          "id",
          "status",
          "score",
          "percentage",
          "trophy",
          "points",
          "started_at",
          "completed_at",
        ].join(","),

      limit: "1",
    });

  const rows =
    await supabase(
      `attempts?${params.toString()}`
    );

  return rows?.[0] ?? null;
}

async function getAnswers(
  attemptId
) {
  const params =
    new URLSearchParams({
      attempt_id:
        `eq.${attemptId}`,

      select:
        "question_key,answer_data,is_correct",

      order:
        "created_at.asc",
    });

  return await supabase(
    `attempt_answers?${params.toString()}`
  );
}

function getCorrectAnswer(
  question
) {
  const evaluation =
    question.evaluation;

  if (!evaluation) {
    return null;
  }

  if (
    evaluation.mode ===
    "exact_set"
  ) {
    return (
      evaluation.correct ?? []
    );
  }

  if (
    evaluation.mode ===
    "normalized_text"
  ) {
    return (
      evaluation.accepted?.[0] ??
      null
    );
  }

  /*
    Q9 notamment :
    pas de "bonne réponse".
  */
  if (
    evaluation.mode ===
    "any_nonempty"
  ) {
    return null;
  }

  return null;
}

function buildReviewQuestion(
  question,
  savedAnswer
) {
  const evaluation =
    question.evaluation;

  const reflective =
    evaluation?.mode ===
      "any_nonempty" ||
    question.reviewMode ===
      "reflective";

  const review = {
    id:
      question.id,

    type:
      question.type,

    title:
      question.title ?? null,

    prompt:
      question.prompt ?? "",

    helper:
      question.helper ?? null,

    reflective,

    submittedAnswer:
      savedAnswer
        ?.answer_data
        ?.value ?? null,

    isCorrect:
      reflective
        ? null
        : savedAnswer
            ?.is_correct ?? false,

    correctAnswer:
      getCorrectAnswer(
        question
      ),

    explanation:
      question.explanation ??
      null,

    reviewVideos:
      Array.isArray(
        question.reviewVideos
      )
        ? question.reviewVideos
        : [],
  };

  if (question.preamble) {
    review.preamble = {
      reference:
        question.preamble
          .reference ?? null,

      text:
        question.preamble
          .text ?? null,
    };
  }

  if (
    Array.isArray(
      question.options
    )
  ) {
    review.options =
      question.options.map(
        (option) => ({
          id:
            option.id,

          text:
            option.text,
        })
      );
  }

  return review;
}

export default async (req) => {
  if (req.method !== "GET") {
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
      1. Connexion
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
      2. quizId
    */

    const url =
      new URL(req.url);

    const quizId =
      String(
        url.searchParams.get(
          "quizId"
        ) ?? ""
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
      4. La tentative doit
      obligatoirement être terminée.
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
            "Vous n'avez pas effectué ce quiz.",
        },
        404
      );
    }

    if (
      attempt.status !==
      "completed"
    ) {
      return json(
        {
          ok: false,

          notCompleted: true,

          error:
            "Les réponses ne sont disponibles qu'après avoir terminé le quiz.",
        },
        403
      );
    }

    /*
      5. Questions officielles
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

    /*
      6. Réponses historiques
    */

    const answerRows =
      await getAnswers(
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
      7. Construction de
      l'écran de révision
    */

    const reviewQuestions =
      questions.map(
        (question) =>
          buildReviewQuestion(
            question,
            answerMap.get(
              question.id
            )
          )
      );

    /*
      8. Réponse
    */

    return json({
      ok: true,

      quiz: {
        id:
          quiz.id,

        title:
          quiz.title,

        pastor:
          quiz.content
            ?.pastor ?? null,

        weekStart:
          quiz.week_start,

        questionCount:
          questions.length,
      },

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

        completedAt:
          attempt.completed_at,
      },

      questions:
        reviewQuestions,
    });

  } catch (error) {
    console.error(
      "Quiz review error:",
      error
    );

    return json(
      {
        error:
          "Impossible de charger vos réponses.",
      },
      500
    );
  }
};

export const config = {
  path: "/api/quiz/review",
};
