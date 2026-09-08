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

async function getUsersForUnit(unitId) {
  const params = new URLSearchParams({
    unit_id: `eq.${unitId}`,
    select:
      "id,display_name,avatar_key",
  });

  return await supabase(
    `users?${params.toString()}`
  );
}

async function getQuizzesForUnit(unitId) {
  const params = new URLSearchParams();

  params.set(
    "or",
    `(unit_id.eq.${unitId},unit_id.is.null)`
  );

  params.set(
    "is_published",
    "eq.true"
  );

  params.set(
    "select",
    "id,week_start,is_current"
  );

  params.set(
    "order",
    "week_start.desc"
  );

  return await supabase(
    `quizzes?${params.toString()}`
  );
}

async function getCompletedAttempts(quizIds) {
  if (!quizIds.length) {
    return [];
  }

  const params = new URLSearchParams();

  params.set(
    "quiz_id",
    `in.(${quizIds.join(",")})`
  );

  params.set(
    "status",
    "eq.completed"
  );

  params.set(
    "select",
    [
      "user_id",
      "quiz_id",
      "points",
      "trophy",
      "score",
      "percentage",
      "completed_at",
    ].join(",")
  );

  return await supabase(
    `attempts?${params.toString()}`
  );
}

function buildLeaderboard(
  users,
  attempts,
  currentUserId
) {
  const userMap = new Map();

  for (const user of users) {
    userMap.set(user.id, {
      userId: user.id,
      displayName:
        user.display_name,
      avatar:
        user.avatar_key,
      points: 0,
      completedQuizzes: 0,
      gold: 0,
      silver: 0,
      bronze: 0,
    });
  }

  for (const attempt of attempts) {
    const player =
      userMap.get(attempt.user_id);

    if (!player) continue;

    player.points +=
      Number(attempt.points ?? 0);

    player.completedQuizzes += 1;

    if (attempt.trophy === "gold") {
      player.gold += 1;
    }

    if (attempt.trophy === "silver") {
      player.silver += 1;
    }

    if (attempt.trophy === "bronze") {
      player.bronze += 1;
    }
  }

  const ranking =
    [...userMap.values()]
      .filter(
        (player) =>
          player.completedQuizzes > 0
      )
      .sort((a, b) => {
        if (b.points !== a.points) {
          return b.points - a.points;
        }

        if (b.gold !== a.gold) {
          return b.gold - a.gold;
        }

        if (b.silver !== a.silver) {
          return b.silver - a.silver;
        }

        return a.displayName.localeCompare(
          b.displayName,
          "fr"
        );
      })
      .map((player, index) => ({
        rank: index + 1,
        ...player,
        isCurrentUser:
          player.userId ===
          currentUserId,
      }));

  const currentUser =
    ranking.find(
      (player) =>
        player.userId ===
        currentUserId
    ) ?? null;

  return {
    ranking,
    currentUser,
  };
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
    const url =
      new URL(req.url);

    const type =
      url.searchParams.get("type") ||
      "weekly";

    if (
      !["weekly", "general"].includes(type)
    ) {
      return json(
        {
          error:
            "Type de classement invalide.",
        },
        400
      );
    }

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

    if (
      !user ||
      !user.unit_id
    ) {
      return json(
        {
          error:
            "Unité introuvable.",
        },
        400
      );
    }

    const [users, quizzes] =
      await Promise.all([
        getUsersForUnit(
          user.unit_id
        ),

        getQuizzesForUnit(
          user.unit_id
        ),
      ]);

    let selectedQuizzes =
      quizzes;

    let weekStart = null;

    if (type === "weekly") {
      const currentQuiz =
        quizzes.find(
          (quiz) =>
            quiz.is_current
        );

      weekStart =
        currentQuiz?.week_start ??
        quizzes[0]?.week_start ??
        null;

      selectedQuizzes =
        weekStart
          ? quizzes.filter(
              (quiz) =>
                quiz.week_start ===
                weekStart
            )
          : [];
    }

    const quizIds =
      selectedQuizzes.map(
        (quiz) => quiz.id
      );

    const attempts =
      await getCompletedAttempts(
        quizIds
      );

    const leaderboard =
      buildLeaderboard(
        users,
        attempts,
        user.id
      );

    return json({
      ok: true,

      type,

      weekStart,

      leaderboard:
        leaderboard.ranking,

      currentUser:
        leaderboard.currentUser,
    });
  } catch (error) {
    console.error(
      "Leaderboard error:",
      error
    );

    return json(
      {
        error:
          "Impossible de récupérer le classement.",
      },
      500
    );
  }
};

export const config = {
  path: "/api/leaderboard",
};
