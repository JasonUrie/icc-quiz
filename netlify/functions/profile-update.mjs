import { createHash } from "node:crypto";

const SUPABASE_URL =
  process.env.ICC_QUIZ_SUPABASE_URL;

const SUPABASE_SECRET_KEY =
  process.env.ICC_QUIZ_SUPABASE_SECRET_KEY;

const COOKIE_NAME = "__Host-icc_quiz_session";

const ALLOWED_AVATARS = [
  "bible",
  "dove",
  "fire",
  "shield",
  "sword",
  "candle",
  "wheat",
  "sheep",
  "crown",
  "cross",
];

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

function normalizeName(value) {
  const name = String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();

  if (
    name.length < 2 ||
    name.length > 30
  ) {
    throw new Error(
      "Le nom doit contenir entre 2 et 30 caractères."
    );
  }

  if (
    !/^[\p{L}\p{M}\p{N} .'-]+$/u.test(name)
  ) {
    throw new Error(
      "Le nom contient des caractères non autorisés."
    );
  }

  const simplified = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

  const blockedWords = [
    "fuck",
    "shit",
    "pute",
    "salope",
    "connard",
    "connasse",
    "encule",
    "fdp",
    "nazi",
  ];

  if (
    blockedWords.some((word) =>
      simplified.includes(word)
    )
  ) {
    throw new Error(
      "Ce nom ne peut pas être utilisé."
    );
  }

  return name;
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

  const rows = await supabase(
    `user_sessions?${params.toString()}`
  );

  return rows?.[0] ?? null;
}

async function updateUser(
  userId,
  updates
) {
  const params =
    new URLSearchParams({
      id: `eq.${userId}`,
    });

  const rows = await supabase(
    `users?${params.toString()}`,
    {
      method: "PATCH",

      headers: {
        Prefer:
          "return=representation",
      },

      body:
        JSON.stringify(updates),
    }
  );

  return rows?.[0] ?? null;
}

export default async (req) => {
  if (req.method !== "PATCH") {
    return json(
      {
        error:
          "Méthode non autorisée.",
      },
      405
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
          authenticated: false,
        },
        401
      );
    }

    const body =
      await req.json();

    const updates = {};

    if (
      body.displayName !== undefined
    ) {
      updates.display_name =
        normalizeName(
          body.displayName
        );
    }

    if (
      body.avatar !== undefined
    ) {
      const avatar =
        String(body.avatar);

      if (
        !ALLOWED_AVATARS.includes(
          avatar
        )
      ) {
        return json(
          {
            error:
              "Icône de profil invalide.",
          },
          400
        );
      }

      updates.avatar_key =
        avatar;
    }

    if (
      Object.keys(updates).length === 0
    ) {
      return json(
        {
          error:
            "Aucune modification.",
        },
        400
      );
    }

    const user =
      await updateUser(
        session.user_id,
        updates
      );

    return json({
      ok: true,

      user: {
        id: user.id,
        displayName:
          user.display_name,
        avatar:
          user.avatar_key,
      },
    });
  } catch (error) {
    return json(
      {
        error:
          error?.message ||
          "Impossible de modifier le profil.",
      },
      400
    );
  }
};

export const config = {
  path: "/api/profile",
};
