import { createHash } from "node:crypto";

const SUPABASE_URL = process.env.ICC_QUIZ_SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.ICC_QUIZ_SUPABASE_SECRET_KEY;

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
  const cookieHeader = req.headers.get("cookie") || "";

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
      "id,title,slug,unit_id,week_start,max_score,content,content_version",
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
      "id,status,score,percentage,trophy,points,started_at,completed_at",
    limit: "1",
  });

  const rows = await supabase(
    `attempts?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function getSavedAnswers(attemptId) {
  const params = new URLSearchParams({
    attempt_id: `eq.${attemptId}`,
    select:
      "question_key,answer_data,created_at",
    order: "created_at.asc",
  });

  return await supabase(
    `attempt_answers?${params.toString()}`
  );
}

/*
  On construit volontairement une
  version "publique" de la question.

  evaluation, correct, explanation et
  reviewVideos ne sont PAS envoyés.
*/
function sanitizeQuestion(question) {
  const clean = {
    id: question.id,
    type: question.type,
    title: question.title ?? null,
    prompt: question.prompt ?? "",
    helper: question.helper ?? null,
  };

  if (question.preamble) {
    clean.preamble = {
      reference:
        question.preamble.reference ?? null,
      text:
        question.preamble.text ?? null,
    };
  }

  if (Array.isArray(question.options)) {
    clean.options = question.options.map(
      (option) => ({
        id: option.id,
        text: option.text,
      })
    );
  }

  return clean;
}

function buildSavedAnswers(rows) {
  const saved = {};

  for (const row of rows) {
    saved[row.question_key] =
      row.answer_data?.value ?? null;
  }

  return saved;
}

export default async (req) => {
  if (req.method !== "GET") {
    return json(
      {
        error: "Méthode non autorisée.",
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
    // 1. Session

    const token = getCookie(
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

    const session = await getSession(
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

    // 2. quizId

    const url = new URL(req.url);

    const quizId = String(
      url.searchParams.get("quizId") ?? ""
    ).trim();

    if (!quizId) {
      return json(
        {
          error: "Quiz manquant.",
        },
        400
      );
    }

    // 3. Utilisateur + quiz

    const [user, quiz] =
      await Promise.all([
        getUser(session.user_id),
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
          error: "Quiz introuvable.",
        },
        404
      );
    }

    // Quiz local ou global

    if (
      quiz.unit_id &&
      quiz.unit_id !== user.unit_id
    ) {
      return json(
        {
          error:
            "Ce quiz n'est pas disponible pour votre unité.",
        },
        403
      );
    }

    // 4. Questions

    const questions =
      quiz.content?.questions;

    if (
      !Array.isArray(questions) ||
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

    // 5. Tentative

    const attempt = await getAttempt(
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

    // Impossible de rejouer un quiz terminé

    if (
      attempt.status === "completed"
    ) {
      return json(
        {
          ok: false,
          alreadyCompleted: true,

          result: {
            score: attempt.score,
            maxScore: Number(
              quiz.max_score
            ),
            percentage: Number(
              attempt.percentage
            ),
            trophy: attempt.trophy,
            points: attempt.points,
          },
        },
        409
      );
    }

    // 6. Réponses déjà enregistrées

    const savedRows =
      await getSavedAnswers(
        attempt.id
      );

    const savedAnswers =
      buildSavedAnswers(savedRows);

    // 7. Questions nettoyées

    const safeQuestions =
      questions.map(
        sanitizeQuestion
      );

    // 8. Réponse

    return json({
      ok: true,

      quiz: {
        id: quiz.id,
        title: quiz.title,
        slug: quiz.slug,
        pastor:
          quiz.content?.pastor ?? null,
        weekStart:
          quiz.week_start,
        maxScore: Number(
          quiz.max_score
        ),
        contentVersion: Number(
          quiz.content_version
        ),
        questionCount:
          safeQuestions.length,
        questions:
          safeQuestions,
      },

      attempt: {
        id: attempt.id,
        status: attempt.status,
        startedAt:
          attempt.started_at,
        answeredQuestionIds:
          Object.keys(savedAnswers),
        savedAnswers,
      },
    });
  } catch (error) {
    console.error(
      "Quiz play error:",
      error
    );

    return json(
      {
        error:
          "Impossible de charger le quiz.",
      },
      500
    );
  }
};

export const config = {
  path: "/api/quiz/play",
};
