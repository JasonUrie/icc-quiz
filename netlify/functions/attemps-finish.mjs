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
  const cookieHeader =
    req.headers.get("cookie") || "";

  for (const cookie of cookieHeader.split(";")) {
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
  const response =
    await fetch(
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

      limit:
        "1",
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
      id:
        `eq.${userId}`,

      select:
        "id,unit_id",

      limit:
        "1",
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
      id:
        `eq.${quizId}`,

      is_published:
        "eq.true",

      select:
        [
          "id",
          "unit_id",
          "max_score",
          "content",
        ].join(","),

      limit:
        "1",
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

      limit:
        "1",
    });

  const rows =
    await supabase(
      `attempts?${params.toString()}`
    );

  return rows?.[0] ?? null;
}

async function getSavedAnswers(
  attemptId
) {
  const params =
    new URLSearchParams({
      attempt_id:
        `eq.${attemptId}`,

      select:
        [
          "question_key",
          "answer_data",
          "is_correct",
          "created_at",
        ].join(","),

      order:
        "created_at.asc",
    });

  return await supabase(
    `attempt_answers?${params.toString()}`
  );
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function normalizeSet(value) {
  const values =
    Array.isArray(value)
      ? value
      : [value];

  return [...new Set(
    values
      .map((item) =>
        String(item ?? "")
          .trim()
          .toUpperCase()
      )
      .filter(Boolean)
  )].sort();
}

function sameArray(a, b) {
  return (
    a.length === b.length &&
    a.every(
      (value, index) =>
        value === b[index]
    )
  );
}

function evaluateQuestion(
  question,
  answer
) {
  const evaluation =
    question?.evaluation;

  const mode =
    evaluation?.mode;

  if (mode === "exact_set") {
    return sameArray(
      normalizeSet(answer),
      normalizeSet(
        evaluation.correct ?? []
      )
    );
  }

  if (
    mode ===
    "normalized_text"
  ) {
    const accepted =
      Array.isArray(
        evaluation.accepted
      )
        ? evaluation.accepted
        : [];

    const normalizedAnswer =
      normalizeText(answer);

    return accepted
      .map(normalizeText)
      .includes(
        normalizedAnswer
      );
  }

  if (
    mode ===
    "any_nonempty"
  ) {
    if (Array.isArray(answer)) {
      return answer.length > 0;
    }

    return (
      String(answer ?? "")
        .trim()
        .length > 0
    );
  }

  throw new Error(
    `Mode d'évaluation inconnu pour ${question?.id ?? "question"}.`
  );
}

function buildResult(
  score,
  maxScore
) {
  const safeMax =
    Number(maxScore) > 0
      ? Number(maxScore)
      : 1;

  const percentage =
    Number(
      (
        (score / safeMax) *
        100
      ).toFixed(2)
    );

  let trophy = "none";
  let points = 0;

  if (score === safeMax) {
    trophy = "gold";
    points = 3;
  } else if (
    percentage >= 80
  ) {
    trophy = "silver";
    points = 2;
  } else if (
    percentage >= 50
  ) {
    trophy = "bronze";
    points = 1;
  }

  return {
    score,
    maxScore:
      safeMax,
    percentage,
    trophy,
    points,
  };
}

async function insertMissingAnswers(
  rows
) {
  if (!rows.length) return;

  const params =
    new URLSearchParams({
      on_conflict:
        "attempt_id,question_key",
    });

  await supabase(
    `attempt_answers?${params.toString()}`,
    {
      method:
        "POST",

      headers: {
        Prefer:
          "resolution=ignore-duplicates,return=minimal",
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
      id:
        `eq.${attemptId}`,

      status:
        "eq.started",

      select:
        [
          "id",
          "status",
          "score",
          "percentage",
          "trophy",
          "points",
          "completed_at",
        ].join(","),
    });

  const rows =
    await supabase(
      `attempts?${params.toString()}`,
      {
        method:
          "PATCH",

        headers: {
          Prefer:
            "return=representation",
        },

        body:
          JSON.stringify({
            score:
              result.score,

            percentage:
              result.percentage,

            trophy:
              result.trophy,

            points:
              result.points,

            status:
              "completed",

            completed_at:
              new Date()
                .toISOString(),
          }),
      }
    );

  return rows?.[0] ?? null;
}

function attemptResult(
  attempt,
  maxScore
) {
  return {
    score:
      Number(attempt.score),

    maxScore:
      Number(maxScore),

    percentage:
      Number(
        attempt.percentage
      ),

    trophy:
      attempt.trophy,

    points:
      Number(attempt.points),
  };
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
        hashSessionToken(
          token
        )
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

    let payload;

    try {
      payload =
        await req.json();
    } catch {
      return json(
        {
          error:
            "Données invalides.",
        },
        400
      );
    }

    const quizId =
      String(
        payload?.quizId ?? ""
      ).trim();

    const submittedAnswers =
      payload?.answers &&
      typeof payload.answers ===
        "object" &&
      !Array.isArray(
        payload.answers
      )
        ? payload.answers
        : {};

    if (!quizId) {
      return json(
        {
          error:
            "Quiz manquant.",
        },
        400
      );
    }

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
            "Le contenu du quiz est indisponible.",
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
          ok: false,
          needsStart: true,
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
          alreadyCompleted:
            true,
          result:
            attemptResult(
              attempt,
              quiz.max_score
            ),
        },
        409
      );
    }

    /*
      Compatibilité avec les tests précédents :
      si certaines réponses avaient déjà été enregistrées
      par l'ancienne version, elles restent verrouillées.
    */
    const beforeRows =
      await getSavedAnswers(
        attempt.id
      );

    const existingByQuestion =
      new Map(
        (beforeRows ?? []).map(
          (row) => [
            row.question_key,
            row,
          ]
        )
      );

    const missingQuestions = [];
    const rowsToInsert = [];

    for (
      const question
      of questions
    ) {
      if (
        existingByQuestion.has(
          question.id
        )
      ) {
        continue;
      }

      if (
        !Object.prototype
          .hasOwnProperty.call(
            submittedAnswers,
            question.id
          )
      ) {
        missingQuestions.push(
          question.id
        );

        continue;
      }

      const answer =
        submittedAnswers[
          question.id
        ];

      const isCorrect =
        evaluateQuestion(
          question,
          answer
        );

      rowsToInsert.push({
        attempt_id:
          attempt.id,

        question_key:
          question.id,

        answer_data: {
          value:
            answer,
        },

        is_correct:
          isCorrect,
      });
    }

    if (
      missingQuestions.length
    ) {
      return json(
        {
          ok: false,
          incomplete: true,
          answered:
            questions.length -
            missingQuestions.length,
          total:
            questions.length,
          missingQuestions,
        },
        400
      );
    }

    /*
      UNE SEULE insertion Supabase pour toutes les réponses
      encore absentes.
    */
    await insertMissingAnswers(
      rowsToInsert
    );

    /*
      On relit ensuite les réponses effectivement stockées.
      C'est cette version serveur qui fait foi pour le score.
    */
    const savedRows =
      await getSavedAnswers(
        attempt.id
      );

    const validQuestionIds =
      new Set(
        questions.map(
          (question) =>
            question.id
        )
      );

    const officialRows =
      (savedRows ?? []).filter(
        (row) =>
          validQuestionIds.has(
            row.question_key
          )
      );

    const savedIds =
      new Set(
        officialRows.map(
          (row) =>
            row.question_key
        )
      );

    const stillMissing =
      questions
        .map(
          (question) =>
            question.id
        )
        .filter(
          (id) =>
            !savedIds.has(id)
        );

    if (
      stillMissing.length
    ) {
      return json(
        {
          ok: false,
          incomplete: true,
          answered:
            officialRows.length,
          total:
            questions.length,
          missingQuestions:
            stillMissing,
        },
        400
      );
    }

    const score =
      officialRows.filter(
        (row) =>
          row.is_correct === true
      ).length;

    const result =
      buildResult(
        score,
        quiz.max_score
      );

    const completed =
      await completeAttempt(
        attempt.id,
        result
      );

    if (completed) {
      return json({
        ok: true,
        result,
      });
    }

    /*
      Deux clics simultanés sur la fin :
      si l'autre requête a terminé avant celle-ci,
      on renvoie simplement le résultat déjà enregistré.
    */
    const latestAttempt =
      await getAttempt(
        user.id,
        quiz.id
      );

    if (
      latestAttempt?.status ===
      "completed"
    ) {
      return json(
        {
          ok: false,
          alreadyCompleted:
            true,
          result:
            attemptResult(
              latestAttempt,
              quiz.max_score
            ),
        },
        409
      );
    }

    throw new Error(
      "La tentative n'a pas pu être finalisée."
    );
  } catch (error) {
    console.error(
      "Attempt finish error:",
      error
    );

    return json(
      {
        error:
          "Impossible de calculer le résultat.",
      },
      500
    );
  }
};

export const config = {
  path:
    "/api/attempts/finish",
};
