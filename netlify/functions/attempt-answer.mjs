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

async function getSession(
  tokenHash
) {
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

async function getUser(
  userId
) {
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

async function getQuiz(
  quizId
) {
  const params =
    new URLSearchParams({
      id: `eq.${quizId}`,
      is_published: "eq.true",

      select:
        "id,unit_id,content",

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
        "id,status",

      limit: "1",
    });

  const rows =
    await supabase(
      `attempts?${params.toString()}`
    );

  return rows?.[0] ?? null;
}

async function getExistingAnswer(
  attemptId,
  questionId
) {
  const params =
    new URLSearchParams({
      attempt_id:
        `eq.${attemptId}`,

      question_key:
        `eq.${questionId}`,

      select:
        "answer_data,is_correct",

      limit: "1",
    });

  const rows =
    await supabase(
      `attempt_answers?${params.toString()}`
    );

  return rows?.[0] ?? null;
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

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toUpperCase();
}

function hasAnswer(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (
    value === undefined ||
    value === null
  ) {
    return false;
  }

  return (
    String(value).trim().length > 0
  );
}

function evaluateQuestion(
  question,
  answer
) {
  const evaluation =
    question.evaluation;

  if (!evaluation?.mode) {
    throw new Error(
      "Configuration de question invalide."
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
    "Mode d'évaluation inconnu."
  );
}

function getCorrection(
  question,
  answer,
  isCorrect
) {
  const evaluation =
    question.evaluation;

  let correctAnswer = null;

  if (
    evaluation.mode ===
    "exact_set"
  ) {
    correctAnswer =
      evaluation.correct ?? [];
  }

  if (
    evaluation.mode ===
    "normalized_text"
  ) {
    correctAnswer =
      evaluation.accepted?.[0] ??
      null;
  }

  return {
    questionId:
      question.id,

    submittedAnswer:
      answer,

    isCorrect,

    reflective:
      evaluation.mode ===
      "any_nonempty",

    correctAnswer,

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
}

async function insertAnswer(
  attemptId,
  questionId,
  answer,
  isCorrect
) {
  await supabase(
    "attempt_answers",
    {
      method: "POST",

      headers: {
        Prefer:
          "return=minimal",
      },

      body:
        JSON.stringify({
          attempt_id:
            attemptId,

          question_key:
            questionId,

          answer_data: {
            value: answer,
          },

          is_correct:
            isCorrect,
        }),
    }
  );
}

async function countAnswers(
  attemptId
) {
  const params =
    new URLSearchParams({
      attempt_id:
        `eq.${attemptId}`,

      select:
        "question_key",
    });

  const rows =
    await supabase(
      `attempt_answers?${params.toString()}`
    );

  return rows?.length ?? 0;
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
      2. Données reçues
    */

    const body =
      await req.json();

    const quizId =
      String(
        body.quizId ?? ""
      ).trim();

    const questionId =
      String(
        body.questionId ?? ""
      ).trim();

    const answer =
      body.answer;

    if (
      !quizId ||
      !questionId
    ) {
      return json(
        {
          error:
            "Données incomplètes.",
        },
        400
      );
    }

    if (!hasAnswer(answer)) {
      return json(
        {
          error:
            "Choisissez une réponse avant de valider.",
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
      4. Question
    */

    const questions =
      quiz.content?.questions;

    if (
      !Array.isArray(
        questions
      )
    ) {
      return json(
        {
          error:
            "Contenu du quiz indisponible.",
        },
        500
      );
    }

    const question =
      questions.find(
        (item) =>
          item.id ===
          questionId
      );

    if (!question) {
      return json(
        {
          error:
            "Question introuvable.",
        },
        404
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
          error:
            "Ce quiz est déjà terminé.",
          alreadyCompleted:
            true,
        },
        409
      );
    }

    /*
      6. Vérification du verrou.

      Si cette question a déjà
      été validée, sa réponse
      ne peut plus être changée.
    */

    const existing =
      await getExistingAnswer(
        attempt.id,
        question.id
      );

    if (existing) {
      const savedAnswer =
        existing.answer_data
          ?.value;

      return json(
        {
          ok: true,
          alreadyAnswered: true,

          correction:
            getCorrection(
              question,
              savedAnswer,
              existing.is_correct
            ),
        },
        200
      );
    }

    /*
      7. Correction côté serveur
    */

    const isCorrect =
      evaluateQuestion(
        question,
        answer
      );

    /*
      8. Enregistrement définitif
    */

    await insertAnswer(
      attempt.id,
      question.id,
      answer,
      isCorrect
    );

    /*
      9. Progression
    */

    const answeredCount =
      await countAnswers(
        attempt.id
      );

    const totalQuestions =
      questions.length;

    /*
      10. Correction autorisée
      après validation
    */

    return json({
      ok: true,

      alreadyAnswered:
        false,

      locked:
        true,

      correction:
        getCorrection(
          question,
          answer,
          isCorrect
        ),

      progress: {
        answered:
          answeredCount,

        total:
          totalQuestions,

        allAnswered:
          answeredCount >=
          totalQuestions,
      },
    });
  } catch (error) {
    console.error(
      "Attempt answer error:",
      error
    );

    return json(
      {
        error:
          "Impossible d'enregistrer la réponse.",
      },
      500
    );
  }
};

export const config = {
  path:
    "/api/attempts/answer",
};
