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
    const error = new Error(
      "Erreur de base de données."
    );

    error.status = response.status;
    error.details = text;

    throw error;
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
      "id,title,slug,unit_id,max_score,is_current",
    limit: "1",
  });

  const rows = await supabase(
    `quizzes?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function getExistingAttempt(
  userId,
  quizId
) {
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

async function createAttempt(
  userId,
  quizId
) {
  const rows = await supabase("attempts", {
    method: "POST",

    headers: {
      Prefer: "return=representation",
    },

    body: JSON.stringify({
      user_id: userId,
      quiz_id: quizId,
      status: "started",
    }),
  });

  return rows?.[0] ?? null;
}

export default async (req) => {
  if (req.method !== "POST") {
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

    const body = await req.json();

    const quizId =
      String(body.quizId ?? "").trim();

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

    // Autorisé si le quiz appartient à l'unité
    // du joueur OU s'il est global (unit_id = null).
    if (
      quiz.unit_id !== null &&
      quiz.unit_id !== user.unit_id
    ) {
      return json(
        {
          error:
            "Ce quiz n'est pas disponible pour ton unité.",
        },
        403
      );
    }

    let attempt =
      await getExistingAttempt(
        user.id,
        quiz.id
      );

    if (attempt) {
      if (attempt.status === "completed") {
        return json(
          {
            ok: false,
            alreadyCompleted: true,

            result: {
              score: attempt.score,
              percentage:
                attempt.percentage,
              trophy: attempt.trophy,
              points: attempt.points,
              completedAt:
                attempt.completed_at,
            },
          },
          409
        );
      }

      // Le joueur avait commencé mais pas terminé :
      // il peut reprendre la même tentative.
      return json({
        ok: true,
        resumed: true,

        attempt: {
          id: attempt.id,
          startedAt:
            attempt.started_at,
        },

        quiz: {
          id: quiz.id,
          title: quiz.title,
          slug: quiz.slug,
          maxScore: quiz.max_score,
        },
      });
    }

    try {
      attempt =
        await createAttempt(
          user.id,
          quiz.id
        );
    } catch (error) {
      // Protection supplémentaire en cas
      // de double clic / requêtes simultanées.
      attempt =
        await getExistingAttempt(
          user.id,
          quiz.id
        );

      if (!attempt) {
        throw error;
      }
    }

    return json({
      ok: true,
      resumed: false,

      attempt: {
        id: attempt.id,
        startedAt:
          attempt.started_at,
      },

      quiz: {
        id: quiz.id,
        title: quiz.title,
        slug: quiz.slug,
        maxScore: quiz.max_score,
      },
    });
  } catch (error) {
    console.error(
      "Attempt start error:",
      error
    );

    return json(
      {
        error:
          "Impossible de démarrer le quiz.",
      },
      500
    );
  }
};

export const config = {
  path: "/api/attempts/start",
};
