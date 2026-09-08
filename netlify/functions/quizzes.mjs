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

async function getQuizzes(unitId) {
  const params = new URLSearchParams();

  params.set("is_published", "eq.true");

  if (unitId) {
    params.set(
      "or",
      `(unit_id.eq.${unitId},unit_id.is.null)`
    );
  } else {
    params.set("unit_id", "is.null");
  }

  params.set(
    "select",
    [
      "id",
      "title",
      "slug",
      "week_start",
      "max_score",
      "is_current",
      "published_at",
      "unit_id",
    ].join(",")
  );

  params.set(
    "order",
    "week_start.desc,published_at.desc"
  );

  return await supabase(
    `quizzes?${params.toString()}`
  );
}

async function getAttempts(userId) {
  const params = new URLSearchParams({
    user_id: `eq.${userId}`,
    select:
      "quiz_id,status,score,percentage,trophy,points,started_at,completed_at",
  });

  return await supabase(
    `attempts?${params.toString()}`
  );
}

export default async (req) => {
  if (req.method !== "GET") {
    return json(
      { error: "Méthode non autorisée." },
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
      getCookie(req, COOKIE_NAME);

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
      new Date(session.expires_at).getTime() <=
        Date.now()
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
      await getUser(session.user_id);

    if (!user) {
      return json(
        {
          ok: false,
          authenticated: false,
        },
        401
      );
    }

    const [quizzes, attempts] =
      await Promise.all([
        getQuizzes(user.unit_id),
        getAttempts(user.id),
      ]);

    const attemptMap =
      new Map(
        attempts.map((attempt) => [
          attempt.quiz_id,
          attempt,
        ])
      );

    const enrichedQuizzes =
      quizzes.map((quiz) => {
        const attempt =
          attemptMap.get(quiz.id) ?? null;

        return {
          ...quiz,

          playStatus: !attempt
            ? "available"
            : attempt.status === "completed"
              ? "completed"
              : "started",

          result:
            attempt?.status === "completed"
              ? {
                  score: attempt.score,
                  percentage:
                    attempt.percentage,
                  trophy: attempt.trophy,
                  points: attempt.points,
                  completedAt:
                    attempt.completed_at,
                }
              : null,
        };
      });

    return json({
      ok: true,

      currentQuiz:
        enrichedQuizzes.find(
          (quiz) => quiz.is_current
        ) ?? null,

      previousQuizzes:
        enrichedQuizzes.filter(
          (quiz) => !quiz.is_current
        ),
    });
  } catch (error) {
    console.error(
      "Quizzes error:",
      error
    );

    return json(
      {
        error:
          "Impossible de récupérer les quiz.",
      },
      500
    );
  }
};

export const config = {
  path: "/api/quizzes",
};
